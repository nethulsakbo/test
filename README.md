# F1 Live Tracker

Live dashboard + 2025 season archive using the free OpenF1 API.

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Notes

- OpenF1 data is for personal, educational, non-commercial use.
- Free tier: historical only. Live during sessions needs Sponsor tier.
- API calls proxied via `/api/openf1/*` for caching & rate-limit safety.
