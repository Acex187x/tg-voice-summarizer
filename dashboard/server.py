#!/usr/bin/env python3
"""Private, read-only Telegram history dashboard.

Reads Convex only when the browser asks: there is no background thread, no
timer and no local copy of the data. Each API call maps to one internal Convex
query from convex/dashboard.ts, which reads one index-bounded page.

Python 3 standard library only.
"""
import ipaddress
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
CONNECTION_FILE = Path(os.environ.get('DASHBOARD_CONNECTION', ROOT / 'connection.json'))
HOST = os.environ.get('DASHBOARD_HOST', '10.10.10.1')
PORT = int(os.environ.get('DASHBOARD_PORT', '8511'))
ALLOWED_HOSTS = set(os.environ.get('DASHBOARD_ALLOWED_HOSTS', '10.10.10.1,localhost,127.0.0.1').split(','))
ALLOWED_NETWORKS = [ipaddress.ip_network(n) for n in os.environ.get(
    'DASHBOARD_ALLOWED_NETWORKS',
    '127.0.0.0/8,10.10.10.1/32,10.20.20.0/24,192.168.1.0/24,192.168.2.0/24').split(',')]

# Page sizes. Each page is one Convex query; see README for byte estimates.
MESSAGES_PAGE = 50
VOICES_PAGE = 30
SUMMARIES_PAGE = 20

_connection = None


class BadRequest(ValueError):
    pass


def connection():
    global _connection
    if _connection is None:
        data = json.loads(CONNECTION_FILE.read_text())
        _connection = {'url': data['url'].rstrip('/'), 'key': data['key']}
    return _connection


def convex_query(path, args):
    """One call to an internal query. No retries: a failed load is shown to the
    user, who can press the button again."""
    conn = connection()
    body = json.dumps({'path': path, 'args': args, 'format': 'json'}).encode()
    req = urllib.request.Request(conn['url'] + '/api/query', data=body, headers={
        'Authorization': 'Convex ' + conn['key'], 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as e:
        try:
            result = json.load(e)
        except Exception:
            raise RuntimeError('Convex ответил ошибкой %s' % e.code) from None
    if result.get('status') != 'success':
        print('Convex query failed:', path, (result.get('errorMessage') or '')[:300], flush=True)
        raise RuntimeError('Convex не выполнил запрос. Повторите позже.')
    return result['value']


def opt_int(params, key):
    value = params.get(key)
    if value in (None, ''):
        return None
    try:
        return int(value)
    except ValueError:
        raise BadRequest('Неверный параметр ' + key) from None


def page_opts(params, size):
    cursor = params.get('cursor') or None
    if cursor is not None and len(cursor) > 4096:
        raise BadRequest('Неверный курсор')
    return {'cursor': cursor, 'numItems': size}


def with_optional(args, **extra):
    args.update({k: v for k, v in extra.items() if v is not None})
    return args


def api_chats(params):
    return convex_query('dashboard:chats', {})


def api_messages(params):
    order = params.get('order') or 'desc'
    if order not in ('asc', 'desc'):
        raise BadRequest('Неверный порядок')
    search = (params.get('q') or '').strip()[:200] or None
    chat = opt_int(params, 'chat')
    args = with_optional({'paginationOpts': page_opts(params, MESSAGES_PAGE), 'order': order},
                         chatId=chat, search=search)
    if not search and chat is not None:
        with_optional(args, fromTs=opt_int(params, 'from'), toTs=opt_int(params, 'to'))
    return convex_query('dashboard:messages', args)


def api_voices(params):
    return convex_query('dashboard:voices', with_optional(
        {'paginationOpts': page_opts(params, VOICES_PAGE)}, chatId=opt_int(params, 'chat')))


def api_summaries(params):
    return convex_query('dashboard:chatSummaries', with_optional(
        {'paginationOpts': page_opts(params, SUMMARIES_PAGE)}, chatId=opt_int(params, 'chat')))


def api_message(params):
    chat, message = opt_int(params, 'chat'), opt_int(params, 'id')
    if chat is None or message is None:
        raise BadRequest('Нужны chat и id')
    return convex_query('dashboard:messageDetail', {'chatId': chat, 'messageId': message})


def convex_id(params):
    value = params.get('id') or ''
    if not value.isalnum() or len(value) > 64:
        raise BadRequest('Неверный id')
    return value


def api_voice(params):
    return convex_query('dashboard:voiceDetail', {'voiceId': convex_id(params)})


def api_summary(params):
    return convex_query('dashboard:chatSummaryDetail', {'chatSummaryId': convex_id(params)})


ROUTES = {
    '/api/chats': api_chats,
    '/api/messages': api_messages,
    '/api/voices': api_voices,
    '/api/summaries': api_summaries,
    '/api/message': api_message,
    '/api/voice': api_voice,
    '/api/summary': api_summary,
}
ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/style.css': ('style.css', 'text/css; charset=utf-8'),
}
SECURITY_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                               "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, data, content='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False).encode() if content.startswith('application/json') else data
        self.send_response(status)
        self.send_header('Content-Type', content)
        self.send_header('Content-Length', str(len(body)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        # No trust in proxy headers: private interface plus source IP and Host checks.
        ip = ipaddress.ip_address(self.client_address[0])
        host = self.headers.get('Host', '').rsplit(':', 1)[0]
        return any(ip in n for n in ALLOWED_NETWORKS) and host in ALLOWED_HOSTS

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {'error': 'Доступ только через VPN / домашнюю сеть'})
        url = urllib.parse.urlsplit(self.path)
        params = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path == '/health':
                # Does not touch Convex.
                return self.send(200, {'ok': True})
            if url.path in ROUTES:
                return self.send(200, ROUTES[url.path](params))
            if url.path in ASSETS:
                name, mime = ASSETS[url.path]
                return self.send(200, (STATIC / name).read_bytes(), mime)
            return self.send(404, {'error': 'Не найдено'})
        except BadRequest as e:
            self.send(400, {'error': str(e)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except RuntimeError as e:
            self.send(502, {'error': str(e)})
        except Exception as e:
            print('Request failed:', url.path, type(e).__name__, flush=True)
            self.send(502, {'error': 'Источник временно недоступен. Повторите запрос.'})


def main():
    os.umask(0o077)
    connection()  # fail fast on a missing or broken connection file
    print('Listening on http://%s:%d (no background sync)' % (HOST, PORT), flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
