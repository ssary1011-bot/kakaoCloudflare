// Cloudflare Worker — kakaoapkmake 빌드 중계 서버
const OWNER = "ssary1011-bot";
const REPO = "kakaoapkmake";
const BRANCH = "main";
const TARGET_PATH = "theme-payload.zip";
const CONFIG_PATH = "theme-name.json";
const WORKFLOW_FILE = "build-apk.yml";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Theme-Name",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

async function gh(path, token, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "kakaoapkmake-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
}

function bufToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function putFile(path, content, token, sha) {
  const res = await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `update ${path}`,
      content: bufToBase64(new TextEncoder().encode(content)),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    const token = env.GITHUB_TOKEN;
    if (!token) return json({ ok: false, error: "GITHUB_TOKEN not configured" }, 500);

    // ── POST /build ──
    if (url.pathname === "/build" && request.method === "POST") {
      try {
        const buf = await request.arrayBuffer();
        if (!buf || buf.byteLength === 0) return json({ ok: false, error: "empty body" }, 400);
        if (buf.byteLength > 25 * 1024 * 1024) return json({ ok: false, error: "file too large" }, 413);

        // 테마 이름 헤더에서 읽기
        const rawThemeName = request.headers.get("X-Theme-Name") || "";
        const themeName = decodeURIComponent(rawThemeName).trim() || "kakao-theme";

        // theme-name.json 저장 (워크플로에서 APK 파일명으로 사용)
        const configGetRes = await gh(`/repos/${OWNER}/${REPO}/contents/${CONFIG_PATH}?ref=${BRANCH}`, token);
        const configSha = configGetRes.status === 200 ? (await configGetRes.json()).sha : undefined;
        await putFile(CONFIG_PATH, JSON.stringify({ themeName }), token, configSha);

        // zip 커밋
        const base64Content = bufToBase64(buf);
        const getRes = await gh(`/repos/${OWNER}/${REPO}/contents/${TARGET_PATH}?ref=${BRANCH}`, token);
        const sha = getRes.status === 200 ? (await getRes.json()).sha : undefined;

        const beforePush = Date.now();

        const putRes = await gh(`/repos/${OWNER}/${REPO}/contents/${TARGET_PATH}`, token, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `theme update: ${themeName} (${new Date().toISOString()})`,
            content: base64Content,
            branch: BRANCH,
            ...(sha ? { sha } : {}),
          }),
        });

        if (!putRes.ok) {
          const detail = await putRes.text();
          return json({ ok: false, error: "github commit failed", detail }, 502);
        }

        return json({ ok: true, since: beforePush });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // ── GET /status?since=<ms> ──
    if (url.pathname === "/status" && request.method === "GET") {
      try {
        const since = Number(url.searchParams.get("since") || "0");
        const runsRes = await gh(
          `/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${BRANCH}&per_page=5`,
          token
        );
        if (!runsRes.ok) return json({ ok: false, error: "failed to list runs" }, 502);
        const runsJson = await runsRes.json();
        const candidate = (runsJson.workflow_runs || []).find(
          (r) => new Date(r.created_at).getTime() >= since - 15000
        );
        if (!candidate) return json({ ok: true, found: false });

        return json({
          ok: true,
          found: true,
          runId: candidate.id,
          status: candidate.status,
          conclusion: candidate.conclusion,
        });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    // ── GET /download ──
    if (url.pathname === "/download" && request.method === "GET") {
      try {
        const relRes = await gh(`/repos/${OWNER}/${REPO}/releases?per_page=5`, token);
        if (!relRes.ok) return json({ ok: false, error: "failed to list releases" }, 502);
        const releases = await relRes.json();
        let asset = null;
        for (const rel of releases) {
          asset = (rel.assets || []).find((a) => a.name.endsWith(".apk"));
          if (asset) break;
        }
        if (!asset) return json({ ok: false, error: "apk asset not found" }, 404);

        const assetRes = await gh(`/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, token, {
          headers: { Accept: "application/octet-stream" },
        });
        if (!assetRes.ok) return json({ ok: false, error: "failed to fetch asset" }, 502);

        return new Response(assetRes.body, {
          headers: {
            "Content-Type": "application/vnd.android.package-archive",
            "Content-Disposition": `attachment; filename="${asset.name}"`,
            ...cors(),
          },
        });
      } catch (err) {
        return json({ ok: false, error: String(err) }, 500);
      }
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
