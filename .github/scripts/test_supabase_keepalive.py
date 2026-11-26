import io
import importlib.util
from pathlib import Path
import sys
import unittest
import urllib.error

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('supabase_keepalive', Path(__file__).with_name('supabase-keepalive.py'))
supabase_keepalive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supabase_keepalive)
EXPECTED_URL = supabase_keepalive.EXPECTED_URL
NoRedirect = supabase_keepalive.NoRedirect
check = supabase_keepalive.check
configuration_error = supabase_keepalive.configuration_error
DATABASE_ERROR_CATEGORIES = supabase_keepalive.DATABASE_ERROR_CATEGORIES


TOKEN = 'unit-test-token-that-is-long-enough-12345'


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.payload


class FakeOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error

    def open(self, _request, timeout):
        if timeout != 15:
            raise AssertionError('unexpected timeout')
        if _request.get_header('Authorization') != 'Bearer ' + TOKEN:
            raise AssertionError('missing bearer token')
        if _request.get_header('User-agent') != 'satzivo-keepalive/github-actions':
            raise AssertionError('missing scheduler identifier')
        if self.error:
            raise self.error
        return self.response


class KeepaliveTests(unittest.TestCase):
    def test_reports_missing_or_invalid_configuration_without_values(self):
        self.assertIn('KEEPALIVE_URL is missing', configuration_error('', TOKEN))
        self.assertIn('KEEPALIVE_TOKEN is missing', configuration_error(EXPECTED_URL, ''))
        self.assertIn('32 characters', configuration_error(EXPECTED_URL, 'short'))
        stale = configuration_error('https://satzora-green.vercel.app/api/keepalive', TOKEN)
        self.assertIn('satzivo.vercel.app', stale)
        self.assertNotIn(TOKEN, stale)

    def test_accepts_only_the_canonical_production_endpoint(self):
        self.assertIsNone(configuration_error(EXPECTED_URL, TOKEN))
        self.assertIsNotNone(configuration_error(EXPECTED_URL + '?redirect=1', TOKEN))
        self.assertIsNotNone(configuration_error('http://satzivo.vercel.app/api/keepalive', TOKEN))

    def test_success_requires_postgres_confirmation_payload(self):
        opener = lambda *_: FakeOpener(FakeResponse(b'{"ok":true,"check":"postgres"}'))
        self.assertIsNone(check(EXPECTED_URL, TOKEN, opener))
        bad = lambda *_: FakeOpener(FakeResponse(b'{"ok":true}'))
        self.assertIn('did not confirm PostgreSQL', check(EXPECTED_URL, TOKEN, bad))

    def test_http_failures_are_actionable_without_exposing_credentials(self):
        for code, expected, payload in [
            (401, 'before the keep-alive handler', b'<html>Authentication Required</html>'),
            (503, 'HTTP 503', b''),
            (308, 'redirected', b''),
        ]:
            error = urllib.error.HTTPError(EXPECTED_URL, code, 'failed', {}, io.BytesIO(payload))
            opener = lambda *_, error=error: FakeOpener(error=error)
            message = check(EXPECTED_URL, TOKEN, opener)
            self.assertIn(expected, message)
            self.assertNotIn(TOKEN, message)

    def test_401_distinguishes_handler_auth_from_platform_protection(self):
        handler_error = urllib.error.HTTPError(EXPECTED_URL, 401, 'unauthorized', {}, io.BytesIO(b'{"ok":false,"error":"unauthorized"}'))
        opener = lambda *_, error=handler_error: FakeOpener(error=error)
        self.assertIn('handler rejected KEEPALIVE_TOKEN', check(EXPECTED_URL, TOKEN, opener))
        platform_error = urllib.error.HTTPError(EXPECTED_URL, 401, 'unauthorized', {}, io.BytesIO(b'<html>Authentication Required</html>'))
        opener = lambda *_, error=platform_error: FakeOpener(error=error)
        self.assertIn('before the keep-alive handler', check(EXPECTED_URL, TOKEN, opener))

    def test_distinguishes_vercel_configuration_from_database_failure(self):
        for payload, expected in [
            (b'{"ok":false,"error":"not_configured"}', 'PostgreSQL was not queried'),
            (b'{"ok":false,"error":"database_unavailable","category":"tls"}', 'TLS certificate validation'),
            (b'{"ok":false,"error":"database_unavailable","category":"authentication"}', 'PostgreSQL authentication'),
            (b'{"ok":false,"error":"database_unavailable","category":"network"}', 'network or pooler connectivity'),
            (b'{"ok":false,"error":"database_unavailable","category":"permission"}', 'database permissions'),
            (b'{"ok":false,"error":"database_unavailable","category":"sql"}', 'SQL execution or result validation'),
            (b'{"ok":false,"error":"database_unavailable","category":"unknown"}', 'unclassified PostgreSQL connection failure'),
            (b'{"ok":false,"error":"database_unavailable","category":"made-up"}', 'unclassified PostgreSQL connection failure'),
        ]:
            error = urllib.error.HTTPError(EXPECTED_URL, 503, 'unavailable', {}, io.BytesIO(payload))
            opener = lambda *_, error=error: FakeOpener(error=error)
            self.assertIn(expected, check(EXPECTED_URL, TOKEN, opener))

    def test_error_categories_are_fixed_safe_labels(self):
        self.assertEqual(set(DATABASE_ERROR_CATEGORIES), {'tls', 'authentication', 'network', 'permission', 'sql', 'unknown'})
        self.assertTrue(all('password' not in label.lower() and 'token' not in label.lower() for label in DATABASE_ERROR_CATEGORIES.values()))

    def test_no_redirect_handler_refuses_redirects(self):
        handler = NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 308, 'redirect', {}, 'https://other.example'))


if __name__ == '__main__':
    unittest.main()
