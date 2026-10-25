// How informal a chat (or a single speaker) is. Pure helpers shared by the
// prompt builders and the voice policy.

export type ProfanityLevel = "none" | "low" | "medium" | "high";

// The style notes are written by the memory observer with a fixed
// "Мат / Уровень мата" bullet. Parse its verdict instead of letting the
// summarizer guess — swearing is only licensed when the chat is confirmed
// to swear.
export function parseProfanityLevel(
  notes: string | null | undefined,
): ProfanityLevel | null {
  if (!notes) return null;
  const line = notes
    .split("\n")
    .find((l) => /(^|[^\p{L}])мат(а|ом)?([^\p{L}]|$)|обсцен|profanity/iu.test(l));
  if (!line) return null;
  const verdict = line.toLowerCase();
  if (/(мата нет|мату немає|без мата|без мату|не матер|отсутству|відсутн|none)/.test(verdict))
    return "none";
  if (/(очень|много|багато|высок|висок|важк|обильн|постоянн|heavy|сплошн|густо|тотальн|explicit)/.test(verdict))
    return "high";
  if (/(средн|середн|умерен|помірн|medium|периодич|часто|регулярн)/.test(verdict))
    return "medium";
  if (/(мало|редк|рідк|мягк|м'як|низк|light|изредка|минимал|мінімал|слабо)/.test(verdict))
    return "low";
  return null;
}

// Swear-word stems (ru/uk). Used to read the SPEAKER's own register when
// there are no chat notes (DMs, guest mode, fresh chats).
const SWEAR_RE =
  /(^|[^\p{L}])(х[уy][йяеёию]|пизд|пізд|бля|ёб|еба[лнтш]|єба|йоб|сук[аи]|залуп|муда|пидор|підор|нахуй|нахер|хер[ня])/giu;

export function countSwears(text: string): number {
  return text.match(SWEAR_RE)?.length ?? 0;
}

// Whether a cleanup pass should keep the author's swearing. Off only when
// the chat is confirmed to (almost) never swear.
export function keepsProfanity(level: ProfanityLevel | null): boolean {
  return level !== "none" && level !== "low";
}
