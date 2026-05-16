const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: Request, context: RouteContext) {
  return proxy(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxy(request, context);
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(path.join("/"), ensureTrailingSlash(apiBaseUrl));
  target.search = new URL(request.url).search;

  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  if (process.env.DASHBOARD_API_TOKEN) {
    headers.set("authorization", `Bearer ${process.env.DASHBOARD_API_TOKEN}`);
  }

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : await request.text(),
    cache: "no-store"
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  });
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
