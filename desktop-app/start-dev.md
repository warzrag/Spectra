# Starting the Development Server

To run the antidetect browser in development mode, you need to follow these steps:

## Quick Start

1. Open two terminals in the `/mnt/d/claude/client_nico/antidetect-browser/desktop-app` directory

2. **Terminal 1 - Start webpack dev server:**
   ```bash
   npm run dev:react
   ```
   Wait until you see "webpack compiled successfully"

3. **Terminal 2 - Start Electron:**
   ```bash
   npm run dev:electron
   ```

## Alternative: Single Command

You can also run both in a single terminal:
```bash
npm run dev
```

## Troubleshooting

If you see a blank page when launching a profile:

1. Make sure webpack dev server is running on http://localhost:9000
2. Check that the browser files exist in `dist/browser/`
3. If not, run: `npm run build:react` first

## Manual Build

If development mode doesn't work properly:

1. Build the files:
   ```bash
   npm run build:react
   npm run build:electron
   ```

2. Run Electron:
   ```bash
   npm run dev:electron
   ```