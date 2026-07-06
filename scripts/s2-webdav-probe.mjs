/**
 * Spike S2 — WebDAV capability probe.
 *
 * Verifies whether a WebDAV backend (target: Infomaniak kDrive) returns usable
 * ETags and honors conditional writes (If-Match / If-None-Match), which the
 * SelfSync manifest relies on for optimistic concurrency (docs/05-sync-engine.md,
 * docs/06-backends.md). If it does not, the engine falls back to hash-compare +
 * a manifest lock object.
 *
 * Reads credentials from the environment (see .env.local.example):
 *   SELFSYNC_WEBDAV_URL   base WebDAV URL (e.g. https://<id>.connect.kdrive.infomaniak.com/)
 *   SELFSYNC_WEBDAV_USER  username (Infomaniak email)
 *   SELFSYNC_WEBDAV_PASS  password (kDrive requires an app-specific password)
 *
 * Run (portable Node + corporate CA):
 *   node --env-file=.env.local scripts/s2-webdav-probe.mjs
 *
 * The probe creates and then deletes a temporary folder "selfsync-s2-probe/".
 * It never prints your password.
 */

const BASE = process.env.SELFSYNC_WEBDAV_URL;
const USER = process.env.SELFSYNC_WEBDAV_USER;
const PASS = process.env.SELFSYNC_WEBDAV_PASS;

if (!BASE || !USER || !PASS) {
  console.error(
    "Missing credentials. Set SELFSYNC_WEBDAV_URL, SELFSYNC_WEBDAV_USER, SELFSYNC_WEBDAV_PASS\n" +
      "(copy .env.local.example to .env.local and fill it in), then run:\n" +
      "  node --env-file=.env.local scripts/s2-webdav-probe.mjs",
  );
  process.exit(2);
}

const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const PROBE_DIR = "selfsync-s2-probe";

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

async function dav(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: AUTH, ...headers },
    body,
    redirect: "manual",
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, etag: res.headers.get("etag"), text, headers: res.headers };
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // decode &amp; last
}

function parseEtagFromPropfind(xml) {
  const m = xml.match(/<[^>]*getetag[^>]*>([^<]*)<\/[^>]*getetag>/i);
  // WebDAV servers may XML-entity-encode the quoted ETag (kDrive returns
  // &quot;…&quot;); decode before using it as an If-Match value.
  return m ? decodeEntities(m[1].trim()) : null;
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass === true ? "✓ PASS" : pass === false ? "✗ FAIL" : "– INFO";
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return "(unparseable URL)";
  }
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>';

async function main() {
  console.log(`\nSelfSync S2 WebDAV probe`);
  console.log(`Host: ${host(BASE)}  (user: ${USER.slice(0, 2)}…)`);
  console.log("");

  // 1. Auth + reachability.
  console.log("1) Connectivity & auth");
  const propRoot = await dav("PROPFIND", joinUrl(BASE, ""), {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: PROPFIND_BODY,
  });
  const authOk = propRoot.status >= 200 && propRoot.status < 300;
  record(
    "PROPFIND base URL authenticates",
    authOk,
    `HTTP ${propRoot.status}${authOk ? "" : " (401=bad creds, 403=forbidden, 405=method blocked)"}`,
  );
  if (!authOk) {
    summarize();
    process.exit(1);
  }

  // 2. Ensure a clean probe directory.
  console.log("\n2) Prepare temp folder");
  await dav("DELETE", joinUrl(BASE, PROBE_DIR + "/")); // best-effort cleanup of a prior run
  const mkcol = await dav("MKCOL", joinUrl(BASE, PROBE_DIR + "/"));
  record("MKCOL temp folder", mkcol.status === 201 || mkcol.status === 405, `HTTP ${mkcol.status}`);

  const fileA = joinUrl(BASE, `${PROBE_DIR}/probe-a.txt`);

  // 3. PUT and inspect the ETag on the response.
  console.log("\n3) PUT + ETag");
  const put1 = await dav("PUT", fileA, { body: "version-1" });
  const putOk = put1.status >= 200 && put1.status < 300;
  record("PUT create", putOk, `HTTP ${put1.status}`);
  // Informational: some servers (incl. kDrive) omit the ETag on PUT, which just
  // means the engine must PROPFIND after a write to learn the new ETag.
  record(
    "PUT response carries an ETag header",
    put1.etag ? true : null,
    put1.etag ? `etag=${put1.etag}` : "no ETag on PUT — follow-up PROPFIND needed",
  );

  // 4. PROPFIND the file for its getetag and compare.
  const propFile = await dav("PROPFIND", fileA, {
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: PROPFIND_BODY,
  });
  const propEtag = parseEtagFromPropfind(propFile.text);
  record("PROPFIND returns <getetag>", !!propEtag, propEtag ? `getetag=${propEtag}` : "not present");
  const etag = propEtag || put1.etag;
  if (etag) {
    const weak = /^\s*W\//i.test(etag);
    record("ETag is strong (not W/…)", !weak, weak ? "weak ETag — unusable for If-Match" : "strong");
    if (put1.etag && propEtag) {
      record("PUT ETag matches PROPFIND ETag", put1.etag.trim() === propEtag.trim(), `${put1.etag} vs ${propEtag}`);
    }
  }

  // 5. Conditional overwrite with the correct ETag.
  console.log("\n4) Conditional writes");
  let etagForCond = etag;
  if (etagForCond) {
    const putMatch = await dav("PUT", fileA, { headers: { "If-Match": etagForCond }, body: "version-2" });
    record("If-Match with CORRECT ETag succeeds", putMatch.status >= 200 && putMatch.status < 300, `HTTP ${putMatch.status}`);
    if (putMatch.etag) etagForCond = putMatch.etag;

    // 6. Conditional overwrite with a wrong ETag must be rejected (412).
    const putStale = await dav("PUT", fileA, {
      headers: { "If-Match": '"this-etag-is-wrong"' },
      body: "version-3-should-fail",
    });
    record("If-Match with WRONG ETag is rejected (412)", putStale.status === 412, `HTTP ${putStale.status}`);
  } else {
    record("If-Match tests", null, "skipped — no ETag available");
  }

  // 7. Create-only semantics via If-None-Match: *.
  const fileC = joinUrl(BASE, `${PROBE_DIR}/probe-cond.txt`);
  await dav("DELETE", fileC);
  const create1 = await dav("PUT", fileC, { headers: { "If-None-Match": "*" }, body: "created" });
  record("If-None-Match:* creates a new file", create1.status >= 200 && create1.status < 300, `HTTP ${create1.status}`);
  const create2 = await dav("PUT", fileC, { headers: { "If-None-Match": "*" }, body: "should-not-overwrite" });
  record("If-None-Match:* rejects overwrite (412)", create2.status === 412, `HTTP ${create2.status}`);

  // 8. Content round-trip.
  console.log("\n5) Content round-trip");
  const get = await dav("GET", fileA);
  record("GET returns latest content", get.text === "version-2", `got ${JSON.stringify(get.text.slice(0, 40))}`);

  // 9. Cleanup.
  console.log("\n6) Cleanup");
  const del = await dav("DELETE", joinUrl(BASE, PROBE_DIR + "/"));
  record("DELETE temp folder", del.status >= 200 && del.status < 300, `HTTP ${del.status}`);

  summarize();
}

function summarize() {
  const fails = results.filter((r) => r.pass === false);
  const condMatch = results.find((r) => r.name.includes("CORRECT ETag"))?.pass === true;
  const condReject = results.find((r) => r.name.includes("WRONG ETag"))?.pass === true;
  const strong = results.find((r) => r.name.includes("strong"))?.pass !== false;

  console.log("\n" + "=".repeat(60));
  if (condMatch && condReject && strong) {
    console.log("VERDICT: ETag optimistic concurrency is USABLE on this backend.");
    console.log("  → StorageBackend.capabilities().conditionalWrites = true");
  } else {
    console.log("VERDICT: ETag conditional writes are NOT reliably supported.");
    console.log("  → Fall back to hash-compare + a manifest lock object.");
  }
  console.log(`Checks: ${results.filter((r) => r.pass === true).length} passed, ${fails.length} failed, ` +
    `${results.filter((r) => r.pass === null).length} skipped.`);
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("\nProbe crashed:", err?.message || err);
  console.error("If this is a TLS error, ensure NODE_OPTIONS=--use-system-ca is set.");
  process.exit(1);
});
