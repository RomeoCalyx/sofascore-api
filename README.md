# SofaScore Proxy API

A small Express relay that fetches data from SofaScore's undocumented JSON API
and serves it over HTTP.

## Why this exists

SofaScore hard-blocks **datacenter IP ranges** with a `403`, and the block
cannot be cleared with better browser impersonation. The identical request
succeeds from a residential connection and fails from a VPS:

| Connection | Result |
| --- | --- |
| Residential | `200` |
| Railway / Render / VPS | `403` |

So this service is deployed somewhere the IP is trusted, and your bot calls
*this* instead of SofaScore directly. It also adds TLS-fingerprint rotation, a
shared cache, and an image relay.

> [!NOTE]
> Deploy this on a **residential** connection. A datacenter host (Railway,
> Render, Fly, any VPS) will hit the same 403 this service exists to avoid.

## Endpoints

| Route | Upstream |
| --- | --- |
| `GET /health` | checks upstream reachability |
| `GET /api/*` | `https://www.sofascore.com/api/v1/*` |
| `GET /img/*` | `https://img.sofascore.com/api/v1/*` (binary) |

The `/api` surface mirrors SofaScore v1 exactly, so callers need no rewrite:

```bash
curl -H "x-api-key: $API_KEY" \
  https://your-host/api/sport/football/events/live
```

### Caching

Append `?cache=<seconds>` to cache a route. Live scores change every few
seconds, so a short TTL still removes almost all duplicate traffic:

```bash
curl "https://your-host/api/team/17/events/next/0?cache=60"
curl "https://your-host/img/team/17/image?cache=86400"   # images default to 3600s
```

Cached JSON responses include `"_cached": true`.

## Configuration

| Env var | Required | Description |
| --- | --- | --- |
| `API_KEY` | **yes** | Shared secret sent as `x-api-key`. Requests without it get `401`. |
| `PORT` | no | Defaults to `3000`. |
| `NODE_ENV` | no | Standard. |

> [!WARNING]
> If `API_KEY` is unset the server still starts, but the auth middleware passes
> every request through — that would expose an open proxy. Always set it.

## Deploy

Must run on Node 20+.

```bash
npm install
API_KEY="your-secret" npm start
```

Render/Railway/Fly all work, **provided** the egress IP is residential — see
the note above.

## Notes

- Upstream `404`s are relayed as `404` (many SofaScore routes no longer exist).
- Upstream refusals surface as `502`/`403` with the upstream status in the body.
- SofaScore rotates its routes without notice; the daily-fixtures endpoint
  (`/sport/{sport}/scheduled-events/{date}`) has already been removed.

## License

MIT
