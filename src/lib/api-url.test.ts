import { describe, expect, test } from 'vitest';
import { getApiUrl } from './api-url';

describe('getApiUrl', () => {
  test('uses the local api path when API_URL is absolute', () => {
    expect(
      getApiUrl('/websites', {
        apiUrl: 'https://gateway-eu.umami.dev/api',
        basePath: '/analytics',
      }),
    ).toBe('/analytics/api/websites');
  });

  test('uses a relative API_URL under the base path', () => {
    expect(
      getApiUrl('/websites', {
        apiUrl: '/internal-api',
        basePath: '/analytics',
      }),
    ).toBe('/analytics/internal-api/websites');
  });

  test('uses a relative API_URL for auth routes', () => {
    expect(
      getApiUrl('/auth/verify', {
        apiUrl: '/internal-api',
        basePath: '/analytics',
      }),
    ).toBe('/analytics/internal-api/auth/verify');
  });

  test('keeps config routes on the local api path', () => {
    expect(
      getApiUrl('/config', {
        apiUrl: '/internal-api',
        basePath: '/analytics',
      }),
    ).toBe('/analytics/api/config');
  });

  test('returns absolute input urls unchanged', () => {
    expect(getApiUrl('https://example.com/api/websites')).toBe('https://example.com/api/websites');
  });
});
