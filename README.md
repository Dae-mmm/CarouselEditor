# Carousel Maker

A browser-based carousel editor for creating Instagram-style photo sequences, with drag-and-drop composition, page management, crop tools, cloud project save, and offline support.

## Overview

Carousel Maker is a front-end application for building social media carousels from images. Users can upload photos, arrange them across multiple pages, customize layout and background, crop images, reorder pages, and export the final result as a JPEG.

The app is designed to work as a Progressive Web App (PWA), so it can be installed on desktop or mobile and used offline.

## Features

- Upload multiple images
- Create multi-page carousel layouts
- Drag and drop image positioning
- Reorder pages and manage page structure
- Crop images directly inside the editor
- Change page aspect ratio (portrait, square, landscape)
- Toggle grid and snap guides for alignment
- Adjust background color
- Zoom in/out and fit-to-screen controls
- Undo/redo history
- Export the final carousel as a JPEG image
- Save projects locally (JSON / .CMF file)
- Cloud save with Supabase authentication and project storage
- Offline-ready PWA support

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
└── README.md
```

## Getting Started

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment variables

Copy the example file:

```bash
cp .env.example .env
```

Then set your Supabase credentials:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 3) Run locally

```bash
npm run dev
```

Then open the local URL shown by Vite in the browser.

## Production Build

```bash
npm run build
```

To preview the production build locally:

```bash
npm run preview
```

## Supabase Setup

This project includes SQL migrations for cloud project storage. The database is used for:

- saving user projects
- storing project metadata
- limiting cloud projects per user
- preserving aspect ratio settings

The migration files are located in:

```text
supabase/migrations/
```

## Usage

1. Upload one or more images.
2. Arrange them on the canvas.
3. Add or reorder pages to build a carousel flow.
4. Crop or align images as needed.
5. Adjust the page format and background.
6. Export the completed carousel.
7. Save locally or in the cloud.

## Notes

- The app is optimized for Instagram-style carousel creation.
- It works well for image-based storytelling, product showcases, and social media content.
- Because it is a PWA, it can be installed and used offline after the first load.

## License

This project does not currently specify an explicit license in the repository.
