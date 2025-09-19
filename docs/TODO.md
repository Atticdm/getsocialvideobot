TODO / Next Steps

- Web: add friendly messages for ERR_* codes on the page.
- Web: optional Range support in /download_video (resume).
- Providers: centralize cookie handling across all providers (cookies.ts done; wire remaining).
- Providers: centralize findDownloadedFile / parseVideoInfoFromPath (utils.ts created; wire remaining providers).
- Rate limiting (web): replace simple activeByIp with reusable core/rateLimit.
- Observability: expose health/metrics (e.g., GET /health, Prometheus metrics).

