// Fake fetch for HTTP sources: the handler gets a URL object and the headers and
// returns { status?, body } (body is JSON-serialised). A request body (GraphQL) is parsed and passed
// third, with the method. Calls are recorded.
import { readFileSync } from 'node:fs';

/** @param {string} rel path under test/fixtures */
export const fixture = (rel) => JSON.parse(readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8'));

/** @param {(url: URL, headers: Record<string,string>, req: { method: string, body: any }) => { status?: number, body: unknown }} handler */
export function fakeFetch(handler, calls = []) {
  return async (url, { headers = {}, method = 'GET', body: sent } = {}) => {
    const u = new URL(url);
    const req = { method, body: sent === undefined ? undefined : JSON.parse(sent) };
    calls.push({ url: u, headers, ...req });
    const { status = 200, body } = handler(u, headers, req);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => JSON.stringify(body),
    };
  };
}
