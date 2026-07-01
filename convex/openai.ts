// LLM client. Despite the filename, this module routes chat calls to either
// OpenAI or OpenRouter based on the caller's provider argument. Audio
// transcription always goes to OpenAI because OpenRouter does not expose a
// compatible audio endpoint.

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type Provider = "openai" | "openrouter";

interface ChatCompleteOpts {
  provider: Provider;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  jsonMode?: boolean;
}

function getOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in Convex env");
  return key;
}

function getOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set in Convex env, but a stage is configured to use OpenRouter. " +
        "Run `npm run setup` after adding it to .env.local.",
    );
  }
  return key;
}

// ---- Transcription (OpenAI only) ------------------------------------------
export async function transcribeAudio(
  audio: Blob,
  model: string,
  filename = "voice.ogg",
): Promise<string> {
  const key = getOpenAIKey();
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("response_format", "text");

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Transcription failed (model=${model}): ${res.status} ${errText}`,
    );
  }
  return (await res.text()).trim();
}

// ---- Chat completion (OpenAI or OpenRouter) -------------------------------
function chatEndpoint(provider: Provider): { base: string; key: string } {
  return {
    base: provider === "openrouter" ? OPENROUTER_BASE : OPENAI_BASE,
    key: provider === "openrouter" ? getOpenRouterKey() : getOpenAIKey(),
  };
}

function chatHeaders(provider: Provider, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/tg-voice-summarizer";
    headers["X-Title"] = "tg-voice-summarizer";
  }
  return headers;
}

function chatBody(
  opts: ChatCompleteOpts,
  stream = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature ?? 0.3,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (stream) body.stream = true;
  return body;
}

export async function chatComplete(opts: ChatCompleteOpts): Promise<string> {
  const { provider, model } = opts;
  const { base, key } = chatEndpoint(provider);

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: chatHeaders(provider, key),
    body: JSON.stringify(chatBody(opts)),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Chat completion failed (provider=${provider} model=${model}): ${res.status} ${errText}`,
    );
  }
  // OpenRouter sometimes returns 200 with `{error: {...}}` or no `choices`
  // at all when the underlying provider hiccups, so be defensive: don't
  // assume the body is well-formed just because the HTTP status was OK.
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; code?: string | number } | string;
  };
  if (json.error) {
    const msg =
      typeof json.error === "string"
        ? json.error
        : (json.error.message ?? "unknown");
    throw new Error(
      `Chat completion failed (provider=${provider} model=${model}): provider error: ${msg}`,
    );
  }
  if (!json.choices || json.choices.length === 0) {
    throw new Error(
      `Chat completion failed (provider=${provider} model=${model}): no choices in response. Body: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  const content = json.choices[0]?.message?.content?.trim() ?? "";
  return content;
}

export async function chatCompleteStream(
  opts: ChatCompleteOpts & {
    onDelta?: (delta: string, full: string) => Promise<void> | void;
  },
): Promise<string> {
  if (opts.jsonMode) {
    throw new Error("chatCompleteStream does not support jsonMode");
  }
  const { provider, model } = opts;
  const { base, key } = chatEndpoint(provider);
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: chatHeaders(provider, key),
    body: JSON.stringify(chatBody(opts, true)),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Chat stream failed (provider=${provider} model=${model}): ${res.status} ${errText}`,
    );
  }
  if (!res.body) {
    throw new Error(
      `Chat stream failed (provider=${provider} model=${model}): empty response body`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: {
        choices?: Array<{ delta?: { content?: string } }>;
        error?: { message?: string } | string;
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.error) {
        const msg =
          typeof parsed.error === "string"
            ? parsed.error
            : (parsed.error.message ?? "unknown");
        throw new Error(
          `Chat stream failed (provider=${provider} model=${model}): provider error: ${msg}`,
        );
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      full += delta;
      await opts.onDelta?.(delta, full);
    }
  }

  buffer += decoder.decode();
  return full.trim();
}

// ---- Embeddings (OpenAI only) --------------------------------------------
export async function createEmbeddings(
  inputs: string[],
  model: string,
  dimensions: number,
): Promise<number[][]> {
  const cleaned = inputs.map((s) => s.trim());
  if (cleaned.some((s) => s.length === 0)) {
    throw new Error("Embedding input cannot be empty");
  }

  const res = await fetch(`${OPENAI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpenAIKey()}`,
    },
    body: JSON.stringify({
      model,
      input: cleaned,
      encoding_format: "float",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Embedding failed (model=${model}): ${res.status} ${errText}`,
    );
  }

  const json = (await res.json()) as {
    data?: Array<{ index: number; embedding: number[] }>;
    error?: { message?: string } | string;
  };
  if (json.error) {
    const msg =
      typeof json.error === "string"
        ? json.error
        : (json.error.message ?? "unknown");
    throw new Error(
      `Embedding failed (model=${model}): provider error: ${msg}`,
    );
  }
  if (!json.data || json.data.length !== cleaned.length) {
    throw new Error(
      `Embedding failed (model=${model}): expected ${cleaned.length} vectors, got ${json.data?.length ?? 0}`,
    );
  }

  const sorted = json.data.slice().sort((a, b) => a.index - b.index);
  return sorted.map((item) => {
    if (
      !Array.isArray(item.embedding) ||
      item.embedding.length !== dimensions
    ) {
      throw new Error(
        `Embedding failed (model=${model}): expected vector length ${dimensions}, got ${item.embedding?.length ?? 0}`,
      );
    }
    return item.embedding;
  });
}

export async function createEmbedding(
  input: string,
  model: string,
  dimensions: number,
): Promise<number[]> {
  const [embedding] = await createEmbeddings([input], model, dimensions);
  return embedding;
}
