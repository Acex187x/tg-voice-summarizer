"""Offline tests: Convex is stubbed, nothing leaves the machine.

Run: python3 -m unittest discover -s dashboard
"""
import json
import re
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import server

STATIC = Path(__file__).resolve().parent / 'static'


class Stub:
    def __init__(self):
        self.calls = []

    def __call__(self, path, args):
        self.calls.append((path, args))
        return {'items': [], 'cursor': None, 'readBytes': 0, 'path': path}


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = Stub()
        server.convex_query = cls.stub
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = 'http://127.0.0.1:%d' % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        self.stub.calls.clear()

    def get(self, path, host=None):
        req = urllib.request.Request(self.base + path, headers={'Host': host} if host else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r) if r.headers['Content-Type'].startswith('application/json') else r.read()
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_messages_in_chat_use_window_and_fixed_page(self):
        status, _ = self.get('/api/messages?chat=-100123&from=100&to=200&order=asc&cursor=abc')
        self.assertEqual(status, 200)
        path, args = self.stub.calls[-1]
        self.assertEqual(path, 'dashboard:messages')
        self.assertEqual(args, {'paginationOpts': {'cursor': 'abc', 'numItems': server.MESSAGES_PAGE},
                                'order': 'asc', 'chatId': -100123, 'fromTs': 100, 'toTs': 200})

    def test_page_size_cannot_be_raised_by_client(self):
        self.get('/api/messages?numItems=100000')
        self.assertEqual(self.stub.calls[-1][1]['paginationOpts']['numItems'], server.MESSAGES_PAGE)

    def test_search_ignores_date_window(self):
        self.get('/api/messages?chat=5&q=%20hello%20&from=1')
        args = self.stub.calls[-1][1]
        self.assertEqual(args['search'], 'hello')
        self.assertNotIn('fromTs', args)

    def test_routes_map_to_dashboard_queries_only(self):
        for url, fn in [('/api/chats', 'dashboard:chats'), ('/api/voices?chat=1', 'dashboard:voices'),
                        ('/api/summaries', 'dashboard:chatSummaries'), ('/api/message?chat=1&id=2', 'dashboard:messageDetail'),
                        ('/api/voice?id=abc123', 'dashboard:voiceDetail'), ('/api/summary?id=abc123', 'dashboard:chatSummaryDetail')]:
            self.assertEqual(self.get(url)[0], 200, url)
            self.assertEqual(self.stub.calls[-1][0], fn)
        self.assertTrue(all(p.startswith('dashboard:') for p, _ in self.stub.calls))

    def test_bad_params_never_reach_convex(self):
        for url in ['/api/messages?chat=abc', '/api/messages?order=sideways', '/api/message?chat=1',
                    '/api/voice?id=../x', '/api/messages?cursor=' + 'a' * 5000]:
            self.assertEqual(self.get(url)[0], 400, url)
        self.assertEqual(self.stub.calls, [])

    def test_health_and_static_do_not_call_convex(self):
        self.assertEqual(self.get('/health'), (200, {'ok': True}))
        self.assertEqual(self.get('/')[0], 200)
        self.assertEqual(self.get('/connection.json')[0], 404)
        self.assertEqual(self.stub.calls, [])

    def test_foreign_host_rejected(self):
        self.assertEqual(self.get('/api/chats', host='evil.example')[0], 403)
        self.assertEqual(self.stub.calls, [])

    def test_no_writes(self):
        req = urllib.request.Request(self.base + '/api/chats', data=b'{}')
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 501)


class NoBackgroundWorkTests(unittest.TestCase):
    def test_server_has_no_sync_loop_or_local_db(self):
        src = Path(server.__file__).read_text()
        for banned in ['sqlite', 'tableData', 'threading.Thread', 'time.sleep', 'Event(', 'Timer(']:
            self.assertNotIn(banned, src, banned)

    def test_browser_has_no_timers(self):
        src = (STATIC / 'app.js').read_text()
        self.assertIsNone(re.search(r'setInterval|setTimeout|requestAnimationFrame|EventSource|WebSocket', src))


if __name__ == '__main__':
    unittest.main()
