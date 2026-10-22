# Carousel Maker

Carousel Maker is a browser-based editor for creating Instagram-style carousels and multi-page social media layouts. It lets you upload images, arrange them across multiple pages, crop and align them, reorder slides, and export the final result as a JPEG.

The app is built as a Progressive Web App (PWA), so it can be installed and used offline on desktop and mobile devices.

## Highlights

- Multi-page carousel canvas
- Drag-and-drop image positioning
- Page reordering and deletion
- Cropping tools for individual images
- Aspect ratio presets: 4:5, 1:1, and 1.91:1
- Snap guides and rule grid for alignment
- Zoom, fit-to-screen, undo/redo controls
- Background color customization
- Local autosave and project file export/import
- Cloud project storage and authentication via Supabase
- Offline-ready install flow with PWA support

## Tech Stack

- Vite
- JavaScript
- Fabric.js
- Tailwind CSS
- Supabase
- Vite PWA plugin

## Project Structure

```text
.
├── .env.example
├── .gitignore
├── index.html
├── package.json
├── package-lock.json
├── vercel.json
├── vite.config.js
├── public/
│   └── icons/
├── src/
│   ├── main.js
│   └── style.css
├── supabase/
│   └── migrations/
│       ├── 001_projects.sql
│       ├── 002_projects_aspect_ratio.sql
│       └── 003_cloud_project_limit.sql
├── README.md
└── manifest.webmanifest
```

## Prerequisites

- Node.js 18+
- npm
- A Supabase project (optional for cloud features, required for cloud save/login)

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Add your Supabase credentials to `.env`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

If Supabase is not configured, the app still works in local mode, but login and cloud project features are disabled.

## Run the app

```bash
npm run dev
```

Then open the URL shown by Vite in your browser.

## Production build

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## How it works

1. Upload one or more images.
2. Adjust the canvas and page layout.
3. Drag, resize, crop, and align images as needed.
4. Reorder pages to build the final carousel flow.
5. Export slides as JPEGs or save the project locally.
6. Sign in with Supabase to save projects in the cloud.

## Project persistence and cloud features

The app supports several save modes:

- Local autosave in browser storage
- Project export/import as `.CMF` files
- Cloud project storage through Supabase
- Up to 3 cloud projects per account, enforced in the database layer

The Supabase schema and related migrations are stored in:

```text
supabase/migrations/
```

## Notes

- The app is optimized for Instagram-style storytelling and social media content creation.
- It is designed for quick editing on both desktop and mobile devices.
- The PWA install prompt is available once the app is loaded in a browser that supports installation.

## License

This project does not currently specify a license in the repository.
