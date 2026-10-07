interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Idaho Statutes — state statutes by citation and by topic. Fleet #2747.
 *
 * SOURCE AND SHAPE. legislature.idaho.gov serves the Idaho Code as plain
 * HTML, one page per section, at a path DERIVABLE from the citation once you
 * know the chapter number: `/statutesrules/idstat/Title{T}/T{T}CH{C}/
 * SECT{T}-{N}/`. The citation itself ("18-4001") does not literally spell
 * out the chapter, but Idaho's own numbering convention does: every chapter
 * owns a contiguous `chapter*100 .. chapter*100+99` block of section numbers
 * — chapter 1 of Title 18 holds "18-100".."18-1xx", chapter 40 holds
 * "18-4000".."18-4099", chapter 83 holds "18-8300".."18-8399" (verified live
 * across chapters 1, 5, 9, 40, 83 and 91 of Title 18, and chapter 1 of the
 * single-chapter Titles 4 and 29). So `chapter = floor(number / 100)` is a
 * formula, not a guess, and `id_statute` below still verifies it rather than
 * trusting it blindly — see "THE VERIFICATION CHAIN".
 *
 * UNLIKE OKLAHOMA (the pack that prompted today's edge-probe rule) Idaho's
 * site gives an HONEST 404 — a real `error404` WordPress template, not a
 * silent 200 — for both a nonexistent CHAPTER and a nonexistent SECTION,
 * verified live (`T18CH999/` and `SECT18-9999/` both 404; a genuine page
 * like `SECT18-4001/` 200s). There is no Texas/California-style "200 with
 * page furniture and no statute" trap here — confirmed by diffing the exact
 * byte length of three different "not found" responses (all 72,512 bytes,
 * the same WP 404 template). That does not excuse skipping the edge probe
 * (see README "Pre-deploy evidence") — it only means the parser does not
 * also have to defend against a disguised 200.
 *
 * THE VERIFICATION CHAIN for id_statute. A wrong chapter guess must never
 * read as "this statute doesn't exist" — that is exactly the failure this
 * pack family is required to avoid. So a 404 from the direct (title,
 * computed-chapter, number) URL does NOT by itself return `found: false`:
 *   1. Fetch the computed chapter's own section-LISTING page
 *      (`Title{T}/T{T}CH{C}/`, no trailing section). If THIS also 404s, the
 *      computed chapter number does not exist in this title at all — the
 *      citation itself is bad (or decimal math is off); return `found:
 *      false` with nearby real chapters from the baked title/chapter index
 *      as a hint.
 *   2. If the listing 200s, check whether it actually LISTS the exact
 *      section citation (every chapter's listing enumerates each of its own
 *      sections by number, catchline included — see bake-index.mjs's
 *      header). If it is NOT listed, the chapter is real but this section
 *      genuinely does not exist (gap numbers — reserved, repealed, or never
 *      assigned — are normal in Idaho's numbering and simply have no page);
 *      return `found: false` with the chapter's real catchline and nearby
 *      listed sections.
 *   3. If the listing DOES list the citation but the direct section fetch
 *      404'd anyway, that is a genuine inconsistency between two live pages
 *      of the same site, not an absence of law — throw a LOUD error rather
 *      than silently reporting `found: false`.
 * A non-404 failure (403, 5xx, timeout) at ANY step is also thrown loud via
 * `httpError`, never swallowed into `found: false`.
 *
 * TOPIC SEARCH. legislature.idaho.gov runs a real search box
 * (`legislature.search.idaho.gov/search`, visible on every statute page) but
 * it is a hosted third-party appliance (an Inmagic/dtSearch-style product
 * judging by its `IW_FIELD_TEXT`/`IW_DATABASE` form fields) with no
 * documented JSON API and no confirmed stable query contract — risky to
 * depend on. What IS stable and keyless: the Legislature's own title,
 * chapter and per-chapter section listing pages carry an OFFICIAL CATCHLINE
 * for every one of the ~1,468 live chapters AND every one of their ~20,400
 * sections — all baked once by scripts/bake-index.mjs (see that file's
 * header for why both levels are baked, not just chapters: a chapter named
 * "FORCIBLE ENTRY AND UNLAWFUL DETAINER" contains neither "landlord" nor
 * "tenant", so matching chapter catchlines alone would miss the section
 * catchlines inside it that do). id_search therefore matches CATCHLINES,
 * not full statutory prose, and says so.
 *
 * FOUR CAPABILITIES — three available, one is not:
 *   - citation lookup              -> id_statute
 *   - topic/keyword search         -> id_search (official catchlines only —
 *     see its own description for why this is not full-text search)
 *   - amendments/enactment history -> embedded in id_statute's `history`
 *     field, parsed from the statute's own "History:" line (e.g. "[18-4001,
 *     added 1972, ch. 336, sec. 1, p. 928; am. 1977, ch. 154, sec. 1, p.
 *     390; am. 2002, ch. 330, sec. 1, p. 935.]") — Idaho prints one for
 *     essentially every in-force section, unlike North Dakota.
 *   - historical version (the TEXT of a section as it read before an
 *     amendment) -> NOT AVAILABLE. legislature.idaho.gov's online Code shows
 *     the CURRENT text only. Idaho's "Session Laws" archive
 *     (`/statutesrules/sessionlaws/`) publishes one PDF volume per
 *     legislative session back to the 2000s, verified live — but those
 *     volumes are organized by SESSION CHAPTER NUMBER (e.g. "Chapters 1 -
 *     162" for the whole 2025 session), which has no relationship to a Code
 *     citation's title/chapter numbering and is not indexed by statute
 *     section. Reconstructing a prior version would mean searching those PDF
 *     volumes by hand for the amending act named in `history` — out of scope
 *     here, same conclusion mcps/north-dakota-code reached for its own
 *     session-law archive.
 *
 * Keyless, no signup.
 */
import type { IdChapterRow, IdSectionRow } from './id-index-data.js';

// fleet #2754 (LIVE INCIDENT 2026-10-07): this index used to be a STATIC
// import, so every gateway isolate evaluated it at startup whether or not it
// ever served a idaho-code call — ~48MB of retained heap for the six baked state
// codes together, ~13.4MB of the bundle, and about one gateway call in four
// died as Cloudflare 1102 on cold isolates. The data module is now uploaded
// to KV at deploy (workers/gateway/src/pack-baked-indexes.json registers it;
// scripts/sync-gateway-static-json.mjs uploads it) and the gateway injects
// the parsed object as `args._bakedIndex` on every call into this pack.
// It is adopted once and kept for the isolate's life.
//
// NEVER value-import ./id-index-data.js here again — a type-only import is
// erased, a value import puts the whole table back into every isolate. The
// deploy workflow's bundle-size ceiling fails the deploy if that happens.
let ID_CHAPTERS: IdChapterRow[] = [];
let ID_SECTIONS: IdSectionRow[] = [];
let ID_INDEX_CAPTURED_AT = '';
function ensureIndex(args: Record<string, unknown>): void {
  if (ID_SECTIONS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const chapters = idx?.ID_CHAPTERS;
  const sections = idx?.ID_SECTIONS;
  const capturedAt = idx?.ID_INDEX_CAPTURED_AT;
  if (!Array.isArray(chapters) || !Array.isArray(sections) || sections.length === 0 || typeof capturedAt !== 'string') {
    // Loud on purpose: answering from an empty table would read as "no such
    // section" / "no match", a silent wrong answer.
    throw new Error(
      `idaho-code: the baked section index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad citation or query — retry shortly.',
    );
  }
  ID_CHAPTERS = chapters as IdChapterRow[];
  ID_SECTIONS = sections as IdSectionRow[];
  ID_INDEX_CAPTURED_AT = capturedAt;
}

const UA = 'pipeworx-mcp-idaho-code/1.0 (+https://pipeworx.io)';
const UPSTREAM = 'Idaho State Legislature (legislature.idaho.gov)';
const BASE = 'https://legislature.idaho.gov/statutesrules/idstat';

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, UPSTREAM);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#8212;/g, '—')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // decode last: a literal "&amp;amp;" must not double-decode
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Citation shape: "18-4001", "18-101A", up to two trailing letters. */
const CITATION_RE = /^(\d{1,2})-(\d{1,4}[A-Za-z]{0,2})$/;

function normalizeCitation(raw: string): string {
  return raw
    .trim()
    .replace(/^(Idaho\s+Code|I\.?C\.?)\s*/i, '')
    .replace(/^§+\s*/, '')
    .replace(/\s+/g, '');
}

/** Index ID_CHAPTERS by (title, chapter-as-number) once per cold start. */
let chapterIndex: Map<string, IdChapterRow> | null = null;
function chaptersByTitle(): Map<string, IdChapterRow> {
  if (chapterIndex) return chapterIndex;
  const m = new Map<string, IdChapterRow>();
  for (const row of ID_CHAPTERS) m.set(`${row.title}:${Number(row.chapter)}`, row);
  chapterIndex = m;
  return m;
}

function chaptersInTitle(title: number): IdChapterRow[] {
  return ID_CHAPTERS.filter((r) => r.title === title);
}

interface SectionFragment {
  titleHeading: string;
  chapterHeading: string;
  bodyLines: string[];
  historyLine: string | null;
}

/**
 * legislature.idaho.gov embeds each section's statute text as a legacy
 * Arbortext-generated HTML fragment INSIDE the page's WordPress chrome — the
 * fragment itself has its own <html><head><body>. Pull just that body out,
 * split it into its top-level <div> blocks (never nested here, verified
 * across every page in this file's test fixtures), strip inline <span>/<a>
 * markup from each, and classify the lines: TITLE heading, CHAPTER heading,
 * statute body (everything between the chapter-name line and the "History:"
 * marker line), and the history line that follows that marker.
 */
function parseSectionFragment(html: string): SectionFragment | null {
  const bodyMatch = /<body[^>]*onunload="CloseFltwin\(\)"[^>]*>([\s\S]*?)<\/body>/.exec(html);
  if (!bodyMatch) return null;
  const inner = bodyMatch[1]!;

  const divRe = /<div\b[^>]*>([\s\S]*?)<\/div>/g;
  const lines: string[] = [];
  for (let m = divRe.exec(inner); m; m = divRe.exec(inner)) {
    const text = stripTags(m[1]!);
    if (text) lines.push(text);
  }
  if (lines.length < 3) return null;

  const titleHeading = lines[0]!; // "TITLE 18"
  const titleNameLine = lines[1]!;
  const chapterHeading = lines[2]!; // "CHAPTER 40"
  if (!/^TITLE\s+\d+/i.test(titleHeading) || !/^CHAPTER\s+[0-9A-Za-z]+/i.test(chapterHeading)) {
    return null;
  }

  const historyIdx = lines.findIndex((l, i) => i > 3 && /^History:$/i.test(l));
  const bodyLines = lines.slice(4, historyIdx === -1 ? lines.length : historyIdx);
  const historyLine = historyIdx !== -1 ? (lines[historyIdx + 1] ?? null) : null;

  return {
    titleHeading: `${titleHeading} ${titleNameLine}`.trim(),
    chapterHeading: `${chapterHeading} ${lines[3]}`.trim(),
    bodyLines,
    historyLine,
  };
}

/** Pulls the official catchline out of the first body line, e.g.
 *  "18-4001.  Murder defined.  Murder is the unlawful killing..." ->
 *  "Murder defined." The uppercase span wrapping the catchline is already
 *  stripped of its own tags by parseSectionFragment; what is left is plain
 *  text, so this matches on the citation prefix and the first ". " run. */
function splitCatchline(firstLine: string, citation: string): { catchline: string | null; rest: string } {
  const prefixRe = new RegExp(`^${citation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\s*`);
  const afterCitation = firstLine.replace(prefixRe, '');
  const m = /^([^.]{1,120}\.)\s*(.*)$/.exec(afterCitation);
  if (!m) return { catchline: null, rest: afterCitation };
  return { catchline: m[1]!.trim(), rest: m[2]! };
}

/** Does this chapter's own section-listing page list `citation` at all?
 *  Returns the matched catchline when it does. Used both to confirm a
 *  computed chapter number before trusting it, and to recover a nearby
 *  listing when the direct guess was wrong. One extra live request. */
async function listingHasCitation(
  title: number,
  chapter: number,
  citation: string,
): Promise<{ status: number; catchline: string | null; nearby: Array<{ citation: string; catchline: string }> } | null> {
  const url = `${BASE}/Title${title}/T${title}CH${chapter}/`;
  const res = await pwFetch(url);
  if (res.status === 404) return { status: 404, catchline: null, nearby: [] };
  if (!res.ok) throw await httpError(res, `Idaho Statutes chapter listing (Title ${title} Ch. ${chapter})`);
  const html = await res.text();
  const rowRe = new RegExp(
    `<a href="/statutesrules/idstat/Title${title}/T${title}CH${chapter}/SECT${title}-([0-9A-Za-z]+)">[^<]*</a></td>\\s*<td[^>]*>[^<]*</td>\\s*<td[^>]*>\\s*([^<]+?)\\s*</td>`,
    'g',
  );
  const rows: Array<{ citation: string; catchline: string }> = [];
  let matchedCatchline: string | null = null;
  for (let m = rowRe.exec(html); m; m = rowRe.exec(html)) {
    const num = m[1]!;
    const cl = decodeEntities(m[2]!).replace(/\s+/g, ' ').trim();
    rows.push({ citation: `${title}-${num}`, catchline: cl });
    if (num.toUpperCase() === citation.split('-')[1]!.toUpperCase()) matchedCatchline = cl;
  }
  return { status: 200, catchline: matchedCatchline, nearby: rows.slice(0, 8) };
}

async function idStatute(args: Record<string, unknown>) {
  const raw = String(args.citation ?? '').trim();
  if (!raw) {
    return {
      found: false,
      reason: 'empty_citation',
      message: 'id_statute needs a citation, e.g. "18-4001" (murder) or "32-717" (child custody factors).',
    };
  }
  const citation = normalizeCitation(raw);
  const m = CITATION_RE.exec(citation);
  if (!m) {
    return {
      found: false,
      reason: 'unparsed_citation',
      citation: raw,
      message: `"${raw}" is not an Idaho Code citation.`,
      hint: 'Idaho citations are title-number, e.g. "18-4001" (murder, Title 18) or "32-717" (Title 32). Call id_search with a topic instead if you do not have an exact citation.',
    };
  }
  const title = Number(m[1]);
  const numberPart = m[2]!;
  const numericPrefix = /^\d+/.exec(numberPart)![0]!;
  const chapter = Math.floor(Number(numericPrefix) / 100);
  const url = `${BASE}/Title${title}/T${title}CH${chapter}/SECT${title}-${numberPart}/`;

  const res = await pwFetch(url);
  if (res.ok) {
    const html = await res.text();
    const fragment = parseSectionFragment(html);
    if (!fragment) {
      throw new Error(
        `${UPSTREAM}: fetched ${url} (HTTP 200) but could not locate the embedded statute fragment — the page layout may have changed. Raw length ${html.length} bytes.`,
      );
    }
    const { catchline, rest } = splitCatchline(fragment.bodyLines[0] ?? '', citation);
    const bodyLines = [...fragment.bodyLines];
    if (bodyLines.length) bodyLines[0] = rest;
    const text = bodyLines.join('\n').trim();
    if (!text) {
      throw new Error(`${UPSTREAM}: fetched ${url} (HTTP 200) and parsed the fragment, but the statute body was empty — layout may have changed.`);
    }

    return {
      found: true,
      citation: `Idaho Code § ${citation}`,
      catchline,
      chapter: String(chapter),
      chapter_heading: fragment.chapterHeading,
      title: String(title),
      title_heading: fragment.titleHeading,
      text,
      text_chars: text.length,
      history: fragment.historyLine,
      historical_versions:
        'not available — legislature.idaho.gov publishes the CURRENT text only. Its Session Laws archive (/statutesrules/sessionlaws/) has one PDF volume per legislative session back to the 2000s, but those are organized by session chapter number, not indexed by Code citation, so recovering a prior version means searching those volumes by hand for the amending act named in `history`.',
      url,
      source: `${UPSTREAM}, keyless`,
      attribution: 'Idaho statutes are public record.',
      data_as_of: new Date().toISOString(),
    };
  }

  if (res.status !== 404) {
    throw await httpError(res, `Idaho Statutes section (${citation})`);
  }

  // Direct guess 404'd — verify via the chapter's own listing before
  // concluding anything (see file header, "THE VERIFICATION CHAIN").
  const listing = await listingHasCitation(title, chapter, citation);
  if (!listing) {
    throw new Error(`${UPSTREAM}: unexpected empty listing-check result for Title ${title} Ch. ${chapter} — this is a pack bug, not an upstream fact.`);
  }

  if (listing.status === 404) {
    const realChapters = chaptersInTitle(title);
    const titleName = realChapters[0]?.titleName ?? null;
    return {
      found: false,
      reason: 'chapter_not_found',
      citation: `Idaho Code § ${citation}`,
      message: `Computed chapter ${chapter} of Title ${title} does not exist (its listing page also 404s) — "${raw}" does not resolve to a real Idaho Code chapter.`,
      title: String(title),
      title_name: titleName,
      nearby_chapters: realChapters
        .map((r) => ({ chapter: r.chapter, chapter_name: r.chapterName }))
        .sort((a, b) => Math.abs(Number(a.chapter) - chapter) - Math.abs(Number(b.chapter) - chapter))
        .slice(0, 8),
      hint: 'Call id_search with a topic to find the right chapter, or id_title_chapters-style browsing is not exposed — check "nearby_chapters" above.',
      index_captured_at: ID_INDEX_CAPTURED_AT,
      source: `${UPSTREAM}, keyless`,
    };
  }

  if (listing.catchline) {
    // The chapter's own listing says this section exists, but the direct
    // fetch 404'd. That is an inconsistency between two live pages of the
    // same site, not an absence of law — loud, not found:false.
    throw new Error(
      `${UPSTREAM}: Title ${title} Ch. ${chapter}'s listing page lists "${citation}" (catchline "${listing.catchline}") but ${url} returned HTTP 404. Inconsistent live state, not a missing statute.`,
    );
  }

  return {
    found: false,
    reason: 'citation_not_found',
    citation: `Idaho Code § ${citation}`,
    message: `Chapter ${chapter} of Title ${title} exists, but "${raw}" is not one of its listed sections.`,
    hint: 'Gap numbers (reserved, repealed, or never assigned) are normal in Idaho\'s numbering. "nearby" lists the chapter\'s actual sections.',
    nearby: listing.nearby,
    source: `${UPSTREAM}, keyless`,
  };
}

interface SectionHit { citation: string; catchline: string; chapterIdx: number; score: number }

/** IDF-weighted word overlap over official SECTION catchlines (+ their own
 *  chapter's catchline, for recall when the word lives in the chapter name
 *  rather than any one section's — e.g. "homicide" matching chapter 40's
 *  name even though no individual section repeats the word). Same scoring
 *  shape as mcps/north-dakota-code's nd_search; unlike the first cut of
 *  this file, matching runs over the FULL baked section index (20,389
 *  rows) rather than drilling live into only the top-ranked chapters — see
 *  bake-index.mjs's header for why: a chapter named "FORCIBLE ENTRY AND
 *  UNLAWFUL DETAINER" contains neither "landlord" nor "tenant", so a
 *  chapter-first pass never reached its own section catchlines that do. */
function wordWeights(words: string[], haystacks: string[]): Map<string, number> {
  const weight = new Map<string, number>();
  for (const w of words) {
    let df = 0;
    for (const h of haystacks) if (h.includes(w)) df++;
    weight.set(w, 1 / Math.max(1, df));
  }
  return weight;
}

async function idSearch(args: Record<string, unknown>) {
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false,
      reason: 'empty_query',
      message: 'id_search needs a "query" — a topic or a few keywords, e.g. "landlord security deposit" or "concealed weapon permit".',
      hint: 'To look up a known citation directly, use id_statute instead.',
    };
  }
  const limit = Math.min(25, Math.max(1, Number(args.limit) || 10));
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) {
    return { found: false, reason: 'query_too_short', query: q, message: `"${q}" has no word of 3+ characters to match against section catchlines.` };
  }

  const haystacks = ID_SECTIONS.map((r) => `${r[1]} ${ID_CHAPTERS[r[2]]!.chapterName}`.toLowerCase());
  const weight = wordWeights(words, haystacks);

  const hits: SectionHit[] = [];
  for (let i = 0; i < ID_SECTIONS.length; i++) {
    const h = haystacks[i]!;
    let score = 0;
    for (const w of words) if (h.includes(w)) score += weight.get(w) ?? 1;
    if (score > 0) hits.push({ citation: ID_SECTIONS[i]![0], catchline: ID_SECTIONS[i]![1], chapterIdx: ID_SECTIONS[i]![2], score });
  }
  hits.sort((a, b) => b.score - a.score);

  if (!hits.length) {
    return {
      found: false,
      query: q,
      message: `No section or chapter catchline in the Idaho Code matched "${q}".`,
      hint: 'This matches official CATCHLINES (section and chapter names), not full statutory text — try shorter or more literal terms.',
      sections_scanned: ID_SECTIONS.length,
      data_as_of: ID_INDEX_CAPTURED_AT,
    };
  }

  const results = hits.slice(0, limit).map((h) => {
    const chapter = ID_CHAPTERS[h.chapterIdx]!;
    return {
      citation: `Idaho Code § ${h.citation}`,
      section: h.citation,
      catchline: h.catchline,
      chapter: chapter.chapter,
      chapter_name: chapter.chapterName,
      title: String(chapter.title),
      title_name: chapter.titleName,
    };
  });

  return {
    found: true,
    query: q,
    count: results.length,
    total_matched: hits.length,
    results,
    hint: 'Call id_statute with a citation above for the full text.',
    match_level: 'official_catchline',
    source: `${UPSTREAM} Idaho Statutes title/chapter/section listing, keyless`,
    data_as_of: ID_INDEX_CAPTURED_AT,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'id_statute',
    description:
      'Get the FULL TEXT of a section of the Idaho Statutes (Idaho Code) by citation. "18-4001" is murder; "32-717" lists child custody factors. Accepts natural forms: "18-4001", "Idaho Code 18-4001", "I.C. § 18-4001". Returns the current statutory text, the official catchline, chapter/title context, and the amendment HISTORY line Idaho prints on nearly every section (e.g. "[18-4001, added 1972, ch. 336, sec. 1, p. 928; am. 1977...]"). Idaho publishes the CURRENT text only — no per-year historical archive of statute text (only session-law PDF volumes organized by session chapter, not by Code citation); this tool says so rather than guessing. Keyless. Use for "what does Idaho Code 18-4001 say" or to check an Idaho statute a case or lease relies on.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Section citation, title-number, e.g. "18-4001" (murder) or "55-307" (landlord access to leased premises). Some sections carry a letter suffix, e.g. "18-101A".',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'id_search',
    description:
      'Search the Idaho Statutes BY TOPIC or keyword rather than citation — "landlord security deposit", "concealed weapon permit", "child custody". Matches against the Idaho Legislature\'s own official chapter and section CATCHLINES across all ~20,400 sections (not full statutory prose — Idaho does not publish a keyless full-text search API, verified live; its hosted search box has no documented contract). Returns matching citations and catchlines; call id_statute with a citation for the full text. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "landlord security deposit".' },
        limit: { type: 'number', description: 'Max results to return, default 10, max 25.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'id_statute':
      return idStatute(args);
    case 'id_search':
      return idSearch(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
