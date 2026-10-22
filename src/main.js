import './style.css';
import { fabric } from 'fabric';
import { createClient } from '@supabase/supabase-js';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

// --- SUPABASE ---
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
if (!supabaseConfigured) {
    console.warn(
        'Supabase non configurato: imposta VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (locale: .env, Vercel: Project Settings → Environment Variables).'
    );
}
const supabaseClient = supabaseConfigured
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

let currentUser = null;
let currentProjectId = null;
let currentProjectName = null;
let authMode = 'login';
let toastTimer = null;
let isAdmin = false;
let libraryAssets = [];
let libraryCategory = 'all';
let libraryLoaded = false;

function requireSupabase() {
    if (!supabaseClient) {
        const message = 'Supabase non configurato. Aggiungi VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY su Vercel, poi ridistribuisci.';
        showToast(message, true);
        throw new Error(message);
    }
    return supabaseClient;
}


// Formati Instagram: verticale 4:5, quadrato 1:1, orizzontale 1.91:1
const ASPECT_PRESETS = {
    '4:5': { w: 1080, h: 1350 },
    '1:1': { w: 1080, h: 1080 },
    '1.91:1': { w: 1080, h: 566 }
};
const ASPECT_ALIASES = {
    '3:4': '4:5',
    '4:3': '1.91:1'
};
const MAX_IMAGE_SHORT_SIDE = 1350;
const PROXY_SHORT_SIDE = 720;
const HIRES_SHORT_SIDE = 2160;
const STORAGE_KEY = 'carousel-maker-project-v4';
const PROJECT_TYPE = 'carousel-maker-project';
const PROJECT_VERSION = 2;
const FABRIC_JSON_PROPS = [
    'isGuideLine', 'selectable', 'evented', 'isAlignmentLine', 'isCropRect',
    'hiResId', 'proxyNaturalWidth', 'proxyNaturalHeight'
];
const LONG_PRESS_MOVE_TOL = 12;
const FIT_SCALE = 0.86; // pagine un filo più piccole del fit pieno
const HIRES_DB_NAME = 'carousel-maker-hires-v1';
const HIRES_STORE = 'images';

let aspectRatio = '1:1';
let pageW = ASPECT_PRESETS['1:1'].w;
let pageH = ASPECT_PRESETS['1:1'].h;
let squareCount = 1;
let guideLines = [];

function resolveAspectKey(key) {
    if (ASPECT_PRESETS[key]) return key;
    if (ASPECT_ALIASES[key] && ASPECT_PRESETS[ASPECT_ALIASES[key]]) return ASPECT_ALIASES[key];
    return '1:1';
}

let historyStack = [];
let historyIndex = -1;
let isHistoryAction = false;

let isCropping = false;
let cropRect = null;
let imgToCrop = null;

let currentZoom = 1;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.1;
const MIN_CANVAS_BLEED = 320;
const MAX_CANVAS_BLEED = 1800;
const CONTROL_BLEED_PAD = 72;
let canvasBleed = MIN_CANVAS_BLEED;

let deferredInstallPrompt = null;
let currentVisiblePage = 0;
let pageEditorMode = false;
let isExporting = false;

// --- Long-press page drag state ---
const pageDrag = {
    timer: null,
    ringTimer: null,
    armed: false,      // timer running
    active: false,     // dragging page
    fromIndex: null,
    insertAt: null,
    startClientX: 0,
    startClientY: 0,
    ghostSize: 160
};

// Drag veloce sullo sfondo → pan della visuale
const viewPan = {
    pending: false,
    active: false,
    startClientX: 0,
    startClientY: 0,
    startScrollLeft: 0,
    startScrollTop: 0
};

const scrollLock = {
    active: false,
    left: 0,
    top: 0
};

let showRuleGrid = false;

// Pinch + rotate multitouch (mobile)
const pinchGesture = {
    active: false,
    obj: null,
    startDist: 0,
    startAngle: 0,
    baseScaleX: 1,
    baseScaleY: 1,
    baseAngle: 0,
    startMidCanvas: null,
    baseCenter: null
};

function isMobileUI() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
        || (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 900);
}

function beginScrollLock() {
    const ws = document.getElementById('workspace');
    scrollLock.active = true;
    scrollLock.left = ws.scrollLeft;
    scrollLock.top = ws.scrollTop;
    document.body.classList.add('object-dragging');
}

function endScrollLock() {
    if (!scrollLock.active) return;
    scrollLock.active = false;
    document.body.classList.remove('object-dragging');
}

function updateMobileHint() {
    const hint = document.getElementById('hint-toast');
    if (!hint) return;
    if (pageEditorMode) {
        hint.innerHTML = squareCount < 2
            ? 'Aggiungi almeno due pagine, poi trascina per riordinarle'
            : 'Trascina una <strong>pagina</strong> per spostarla · Fatto per tornare alle foto';
    } else if (isMobileUI()) {
        hint.innerHTML = 'Sposta le foto liberamente · <strong>Pagine</strong> per riordinare il carousel';
    } else {
        hint.innerHTML = 'Modifica le foto · <strong>Pagine</strong> per riordinare il carousel';
    }
}

function applyObjectLockState() {
    const lock = pageEditorMode || pageDrag.active;
    canvas.selection = !lock && !isMobileUI();
    canvas.forEachObject(o => {
        if (o.isGuideLine || o.isAlignmentLine || o.isCropRect) {
            o.selectable = false;
            o.evented = false;
            return;
        }
        o.selectable = !lock;
        o.evented = !lock;
    });
    if (lock) {
        canvas.discardActiveObject();
        updateToolbarPosition();
    }
}

function renderPageEditorFrames() {
    const el = document.getElementById('page-editor-frames');
    if (!el) return;
    el.innerHTML = '';
    el.style.width = (pageW * squareCount) + 'px';
    el.style.height = pageH + 'px';
    for (let i = 0; i < squareCount; i++) {
        const frame = document.createElement('div');
        frame.className = 'page-editor-frame';
        frame.style.left = (i * pageW) + 'px';
        frame.style.width = pageW + 'px';
        frame.style.height = pageH + 'px';
        frame.innerHTML = `<span class="badge">${i + 1}</span><span class="grip">⋮⋮</span>`;
        el.appendChild(frame);
    }
}

function setPageEditorMode(on) {
    on = !!on;
    if (on === pageEditorMode) {
        applyObjectLockState();
        renderPageEditorFrames();
        updateMobileHint();
        return;
    }
    if (on && isCropping) cancelCrop();
    if (!on) cancelPageDrag();
    pageEditorMode = on;
    document.body.classList.toggle('page-editor-mode', pageEditorMode);
    const btn = document.getElementById('btn-page-editor');
    if (btn) {
        btn.classList.toggle('is-active', pageEditorMode);
        btn.setAttribute('aria-pressed', pageEditorMode ? 'true' : 'false');
    }
    applyObjectLockState();
    renderPageEditorFrames();
    updateMobileHint();
    canvas.requestRenderAll();
}

function togglePageEditorMode() {
    setPageEditorMode(!pageEditorMode);
}

function applyInteractionMode() {
    applyObjectLockState();
}

// --- ROTAZIONE ---
const rotateIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%233b82f6' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.59-9.21l5.85 5.85'/%3E%3C/svg%3E";
const rotateImg = document.createElement('img');
rotateImg.src = rotateIcon;

function renderRotateControl(ctx, left, top) {
    const size = 16;
    ctx.save();
    ctx.translate(left, top);
    ctx.drawImage(rotateImg, -size / 2, -size / 2, size, size);
    ctx.restore();
}

fabric.Object.prototype.set({
    transparentCorners: false,
    cornerColor: '#3b82f6',
    borderColor: '#3b82f6',
    cornerSize: 14,
    padding: 0,
    cornerStyle: 'circle',
    snapAngle: 5,
    snapThreshold: 5,
    hasRotatingPoint: false
});

const rotOffset = 22;
['tl', 'tr', 'bl', 'br'].forEach(corner => {
    let x = corner.includes('l') ? -0.5 : 0.5;
    let y = corner.includes('t') ? -0.5 : 0.5;
    fabric.Object.prototype.controls[corner + 'Rotate'] = new fabric.Control({
        x, y,
        offsetX: x * rotOffset, offsetY: y * rotOffset,
        cursorStyle: 'alias',
        actionHandler: fabric.controlsUtils.rotationWithSnapping,
        actionName: 'rotate',
        render: renderRotateControl,
        cornerSize: 24,
        withConnection: false
    });
});

const canvas = new fabric.Canvas('canvas', {
    width: pageW,
    height: pageH,
    backgroundColor: '',
    preserveObjectStacking: true,
    uniformScaling: false,
    uniScaleKey: 'shiftKey',
    allowTouchScrolling: false,
    selection: true,
    enableRetinaScaling: false,
    renderOnAddRemove: true,
    skipOffscreen: false
});
canvas.imageSmoothingEnabled = true;
if (canvas.lowerCanvasEl) canvas.lowerCanvasEl.style.background = 'transparent';
if (canvas.upperCanvasEl) canvas.upperCanvasEl.style.background = 'transparent';

// Fabric 5 disegna oggetti E bounding box/maniglie sullo stesso lower-canvas
// (i controlli dopo restore del clip). Clippa solo i pixel delle foto/testi
// alle pagine: le maniglie crop/resize/rotate restano visibili nel bleed.
const fabricRenderObjects = canvas._renderObjects;
canvas._renderObjects = function (ctx, objects) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pageW * squareCount, pageH);
    ctx.clip();
    fabricRenderObjects.call(this, ctx, objects);
    ctx.restore();
};

/** Su mobile: niente maniglie scale/rotate (si usa multitouch). */
function configureObjectControls(obj) {
    if (!obj || obj.isGuideLine || obj.isAlignmentLine) return;

    if (isMobileUI()) {
        obj.setControlsVisibility({
            tl: false, tr: false, bl: false, br: false,
            ml: false, mt: false, mr: false, mb: false,
            mtr: false,
            tlRotate: false, trRotate: false, blRotate: false, brRotate: false
        });
        obj.hasBorders = true;
        return;
    }

    if (obj.isCropRect) {
        obj.setControlsVisibility({
            tl: true, tr: true, bl: true, br: true,
            ml: true, mt: true, mr: true, mb: true,
            mtr: false,
            tlRotate: false, trRotate: false, blRotate: false, brRotate: false
        });
        return;
    }

    obj.setControlsVisibility({
        tl: true, tr: true, bl: true, br: true,
        ml: true, mt: true, mr: true, mb: true,
        mtr: false,
        tlRotate: true, trRotate: true, blRotate: true, brRotate: true
    });
}

function configureAllObjectControls() {
    canvas.getObjects().forEach(configureObjectControls);
    const active = canvas.getActiveObject();
    if (active) configureObjectControls(active);
    canvas.requestRenderAll();
}

// --- UNDO / REDO ---
function initHistory() {
    historyStack = [];
    historyIndex = -1;
    saveState();
}

function saveState() {
    if (isHistoryAction || isCropping || pageDrag.active) return;
    historyStack = historyStack.slice(0, historyIndex + 1);
    const json = canvas.toJSON(FABRIC_JSON_PROPS);
    historyStack.push({ json, squareCount, aspectRatio });
    historyIndex++;
    updateUndoRedoUI();
    persistProject();
}

function updateUndoRedoUI() {
    document.getElementById('btn-undo').disabled = historyIndex <= 0;
    document.getElementById('btn-redo').disabled = historyIndex >= historyStack.length - 1;
}

function undo() {
    if (historyIndex > 0 && !isCropping && !pageDrag.active) {
        historyIndex--;
        loadHistoryState(historyStack[historyIndex]);
    }
}

function redo() {
    if (historyIndex < historyStack.length - 1 && !isCropping && !pageDrag.active) {
        historyIndex++;
        loadHistoryState(historyStack[historyIndex]);
    }
}

function loadHistoryState(state) {
    isHistoryAction = true;
    if (state.aspectRatio) {
        aspectRatio = resolveAspectKey(state.aspectRatio);
        pageW = ASPECT_PRESETS[aspectRatio].w;
        pageH = ASPECT_PRESETS[aspectRatio].h;
        updateAspectToggleUI();
    }
    canvas.loadFromJSON(state.json, function() {
        squareCount = state.squareCount;
        document.getElementById('square-badge').innerText = squareCount;
        guideLines = canvas.getObjects().filter(o => o.isGuideLine);
        canvas.renderAll();
        isHistoryAction = false;
        updateUndoRedoUI();
        configureAllObjectControls();
        applyObjectLockState();
        updateToolbarPosition();
        renderPagesUI();
        renderRuleGrid();
        renderPageEditorFrames();
        applyZoom();
        persistProject();
    });
}

canvas.on('object:modified', saveState);
canvas.on('object:modified', () => ensureCanvasBleed({ allowShrink: true }));
canvas.on('object:added', (e) => {
    if (!isHistoryAction && !e.target.isGuideLine && !e.target.isCropRect && !e.target.isAlignmentLine) saveState();
    if (!isHistoryAction && !isExporting) ensureCanvasBleed({ allowShrink: false });
});
canvas.on('object:removed', (e) => {
    if (!isHistoryAction && !e.target.isGuideLine && !e.target.isCropRect && !e.target.isAlignmentLine) saveState();
    if (!isHistoryAction && !isExporting) ensureCanvasBleed({ allowShrink: true });
});

// --- SMART GUIDES ---
let currentSnapLines = [];
let pendingSnapMove = null;
let pendingSnapScale = null;
const SNAP_DISTANCE = 12;
const PAGE_SNAP_DISTANCE = 16;
let snapEnabled = true;

function clearGuidelines() {
    if (currentSnapLines.length > 0 || pendingSnapMove || pendingSnapScale) {
        currentSnapLines = [];
        pendingSnapMove = null;
        pendingSnapScale = null;
        canvas.renderAll();
    }
}

function toggleSnap() {
    snapEnabled = !snapEnabled;
    const btn = document.getElementById('btn-snap');
    if (btn) {
        btn.classList.toggle('is-active', snapEnabled);
        btn.setAttribute('aria-pressed', snapEnabled ? 'true' : 'false');
        btn.title = snapEnabled ? 'Snap magnetico attivo' : 'Snap magnetico disattivo';
    }
    if (!snapEnabled) clearGuidelines();
}

function getPageEdgeTargets(obj) {
    const page = getObjectPageIndex(obj);
    const pages = [page];
    if (page > 0) pages.push(page - 1);
    if (page < squareCount - 1) pages.push(page + 1);
    return pages.map(p => ({
        left: p * pageW,
        centerX: p * pageW + pageW / 2,
        right: (p + 1) * pageW,
        top: 0,
        centerY: pageH / 2,
        bottom: pageH,
        isPage: true
    }));
}

function handleSnapping(e) {
    if (pageDrag.active || pageDrag.armed || viewPan.active || pageEditorMode) return;
    const obj = e.target;
    if (!obj || obj.isCropping || obj.isCropRect) return;
    if (!snapEnabled || (e.e && e.e.altKey)) { clearGuidelines(); return; }

    const action = e.transform ? e.transform.action : '';
    const isMoving = action === 'drag';
    const isScaling = action.includes('scale');
    if (!isMoving && !isScaling) { clearGuidelines(); return; }

    const pageThreshBase = Math.max(PAGE_SNAP_DISTANCE, 16 / currentZoom);
    const objThreshBase = Math.max(SNAP_DISTANCE, 12 / currentZoom);

    const objBounds = obj.getBoundingRect(true);
    const objCenter = obj.getCenterPoint();
    const page = getObjectPageIndex(obj);
    const targets = getPageEdgeTargets(obj);
    canvas.getObjects().forEach(t => {
        if (t === obj || t.isGuideLine || t.isCropRect || t.isAlignmentLine) return;
        const tPage = getObjectPageIndex(t);
        if (Math.abs(tPage - page) > 1) return;
        const bounds = t.getBoundingRect(true);
        const center = t.getCenterPoint();
        targets.push({
            left: bounds.left, centerX: center.x, right: bounds.left + bounds.width,
            top: bounds.top, centerY: center.y, bottom: bounds.top + bounds.height
        });
    });

    if (showRuleGrid) {
        for (let i = 0; i < squareCount; i++) {
            const ox = i * pageW;
            targets.push({
                left: ox + pageW / 3,
                right: ox + (2 * pageW) / 3,
                top: pageH / 3,
                bottom: (2 * pageH) / 3,
                isGrid: true
            });
        }
    }

    let linesToDraw = [];

    if (isMoving) {
        let snapX = null, snapY = null;
        let diffX = pageThreshBase + 1, diffY = pageThreshBase + 1;
        let finalLeft = obj.left, finalTop = obj.top;

        targets.forEach(t => {
            const thresh = t.isPage ? pageThreshBase : objThreshBase;
            const xEdges = (t.isPage || t.isGrid) ? [t.left, t.right] : [t.left, t.centerX, t.right];
            const yEdges = (t.isPage || t.isGrid) ? [t.top, t.bottom] : [t.top, t.centerY, t.bottom];
            const objXs = [
                { val: objBounds.left, type: 'left' },
                { val: objCenter.x, type: 'center' },
                { val: objBounds.left + objBounds.width, type: 'right' }
            ];
            xEdges.forEach(tx => {
                objXs.forEach(ox => {
                    const d = Math.abs(ox.val - tx);
                    if (d < thresh && d < diffX) {
                        diffX = d;
                        snapX = tx;
                        if (ox.type === 'left') finalLeft = obj.left + (tx - objBounds.left);
                        if (ox.type === 'center') finalLeft = obj.left + (tx - objCenter.x);
                        if (ox.type === 'right') finalLeft = obj.left + (tx - (objBounds.left + objBounds.width));
                    }
                });
            });
            const objYs = [
                { val: objBounds.top, type: 'top' },
                { val: objCenter.y, type: 'center' },
                { val: objBounds.top + objBounds.height, type: 'bottom' }
            ];
            yEdges.forEach(ty => {
                objYs.forEach(oy => {
                    const d = Math.abs(oy.val - ty);
                    if (d < thresh && d < diffY) {
                        diffY = d;
                        snapY = ty;
                        if (oy.type === 'top') finalTop = obj.top + (ty - objBounds.top);
                        if (oy.type === 'center') finalTop = obj.top + (ty - objCenter.y);
                        if (oy.type === 'bottom') finalTop = obj.top + (ty - (objBounds.top + objBounds.height));
                    }
                });
            });
        });

        if (snapX !== null) linesToDraw.push([snapX, 0, snapX, pageH]);
        if (snapY !== null) linesToDraw.push([page * pageW, snapY, (page + 1) * pageW, snapY]);
        pendingSnapMove = (snapX !== null || snapY !== null) ? { left: finalLeft, top: finalTop } : null;
    }

    if (isScaling) {
        let activeCorner = e.transform.corner || '';
        let scaleSnapX = null, scaleSnapY = null;
        let sDiffX = pageThreshBase + 1, sDiffY = pageThreshBase + 1;

        targets.forEach(t => {
            const thresh = t.isPage ? pageThreshBase : objThreshBase;
            const targetXs = (t.isPage || t.isGrid) ? [t.left, t.right] : [t.left, t.centerX, t.right];
            const targetYs = (t.isPage || t.isGrid) ? [t.top, t.bottom] : [t.top, t.centerY, t.bottom];
            if (activeCorner.includes('l')) targetXs.forEach(tx => { const d = Math.abs(objBounds.left - tx); if (d < thresh && d < sDiffX) { sDiffX = d; scaleSnapX = tx; } });
            else if (activeCorner.includes('r')) targetXs.forEach(tx => { const d = Math.abs((objBounds.left + objBounds.width) - tx); if (d < thresh && d < sDiffX) { sDiffX = d; scaleSnapX = tx; } });
            if (activeCorner.includes('t')) targetYs.forEach(ty => { const d = Math.abs(objBounds.top - ty); if (d < thresh && d < sDiffY) { sDiffY = d; scaleSnapY = ty; } });
            else if (activeCorner.includes('b')) targetYs.forEach(ty => { const d = Math.abs((objBounds.top + objBounds.height) - ty); if (d < thresh && d < sDiffY) { sDiffY = d; scaleSnapY = ty; } });
        });

        if (scaleSnapX !== null) linesToDraw.push([scaleSnapX, 0, scaleSnapX, pageH]);
        if (scaleSnapY !== null) linesToDraw.push([page * pageW, scaleSnapY, (page + 1) * pageW, scaleSnapY]);

        let finalScaleX = obj.scaleX, finalScaleY = obj.scaleY, willSnapScale = false;
        if (!(e.e && e.e.shiftKey)) {
            if (scaleSnapX !== null && activeCorner.includes('r')) {
                let desiredWidth = scaleSnapX - objBounds.left;
                if (desiredWidth > 0) { finalScaleX = desiredWidth / obj.width; willSnapScale = true; }
            }
            if (scaleSnapY !== null && activeCorner.includes('b')) {
                let desiredHeight = scaleSnapY - objBounds.top;
                if (desiredHeight > 0) { finalScaleY = desiredHeight / obj.height; willSnapScale = true; }
            }
        }
        pendingSnapScale = willSnapScale ? { scaleX: finalScaleX, scaleY: finalScaleY } : null;
    }

    currentSnapLines = linesToDraw;
}

canvas.on('object:moving', handleSnapping);
canvas.on('object:scaling', handleSnapping);

canvas.on('mouse:up', function() {
    if (pageDrag.active || pageDrag.armed || viewPan.active) return;
    const obj = canvas.getActiveObject();
    let didSnap = false;
    if (obj && pendingSnapMove) {
        obj.set({ left: pendingSnapMove.left, top: pendingSnapMove.top });
        obj.setCoords();
        didSnap = true;
    }
    if (obj && pendingSnapScale) {
        obj.set({ scaleX: pendingSnapScale.scaleX, scaleY: pendingSnapScale.scaleY });
        obj.setCoords();
        didSnap = true;
    }
    clearGuidelines();
    if (didSnap) canvas.renderAll();
});

canvas.on('after:render', function() {
    if (currentSnapLines.length === 0 && !pendingSnapMove && !pendingSnapScale) return;
    const ctx = canvas.contextContainer;
    ctx.save();
    const vpt = canvas.viewportTransform;
    ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);

    if (currentSnapLines.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = '#ec4899';
        ctx.lineWidth = 1.5 / canvas.getZoom();
        ctx.setLineDash([5 / canvas.getZoom(), 5 / canvas.getZoom()]);
        currentSnapLines.forEach(coords => { ctx.moveTo(coords[0], coords[1]); ctx.lineTo(coords[2], coords[3]); });
        ctx.stroke();
    }

    function drawGhost(left, top, scaleX, scaleY, fill, stroke) {
        const obj = canvas.getActiveObject();
        if (!obj) return;
        ctx.save();
        ctx.translate(left, top);
        ctx.rotate(obj.angle * Math.PI / 180);
        const w = obj.width * scaleX;
        const h = obj.height * scaleY;
        const offsetX = obj.originX === 'center' ? -w / 2 : 0;
        const offsetY = obj.originY === 'center' ? -h / 2 : 0;
        ctx.fillStyle = fill;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2 / canvas.getZoom();
        ctx.setLineDash([6 / canvas.getZoom(), 4 / canvas.getZoom()]);
        ctx.fillRect(offsetX, offsetY, w, h);
        ctx.strokeRect(offsetX, offsetY, w, h);
        ctx.restore();
    }

    if (pendingSnapMove) drawGhost(pendingSnapMove.left, pendingSnapMove.top, canvas.getActiveObject().scaleX, canvas.getActiveObject().scaleY, 'rgba(236,72,153,0.15)', '#ec4899');
    if (pendingSnapScale) {
        const obj = canvas.getActiveObject();
        drawGhost(obj.left, obj.top, pendingSnapScale.scaleX, pendingSnapScale.scaleY, 'rgba(59,130,246,0.15)', '#3b82f6');
    }
    ctx.restore();
});

// --- ZOOM & CENTER ---
function getPageBgColor() {
    const el = document.getElementById('bg-color');
    const fromInput = el && el.value;
    if (fromInput) return fromInput;
    if (canvas.backgroundColor && canvas.backgroundColor !== 'transparent') return canvas.backgroundColor;
    return '#ffffff';
}

function computeCanvasBleed() {
    let bleed = MIN_CANVAS_BLEED;
    if (typeof canvas === 'undefined' || !canvas) return bleed;
    const pagesW = pageW * squareCount;
    canvas.getObjects().forEach(obj => {
        if (obj.isGuideLine || obj.isAlignmentLine) return;
        let bounds;
        try {
            bounds = obj.getBoundingRect(true);
        } catch (_) {
            return;
        }
        bleed = Math.max(
            bleed,
            CONTROL_BLEED_PAD - bounds.left,
            CONTROL_BLEED_PAD - bounds.top,
            bounds.left + bounds.width - pagesW + CONTROL_BLEED_PAD,
            bounds.top + bounds.height - pageH + CONTROL_BLEED_PAD
        );
    });
    return Math.min(MAX_CANVAS_BLEED, Math.ceil(bleed));
}

function applyPageFill() {
    const fill = document.getElementById('page-fill');
    if (!fill) return;
    const bleedPx = canvasBleed * currentZoom;
    fill.style.left = bleedPx + 'px';
    fill.style.top = bleedPx + 'px';
    fill.style.width = (pageW * squareCount * currentZoom) + 'px';
    fill.style.height = (pageH * currentZoom) + 'px';
    fill.style.backgroundColor = getPageBgColor();
}

function applyCanvasViewport() {
    const zoom = currentZoom;
    canvas.setViewportTransform([
        zoom, 0, 0, zoom,
        canvasBleed * zoom,
        canvasBleed * zoom
    ]);
}

function ensureCanvasBleed({ allowShrink = false } = {}) {
    const next = computeCanvasBleed();
    if (next > canvasBleed + 12 || (allowShrink && Math.abs(next - canvasBleed) > 12)) {
        applyZoom();
    }
}

function applyZoom() {
    const wrapper = document.getElementById('canvas-wrapper');
    const overlay = document.getElementById('overlay-layer');
    canvasBleed = computeCanvasBleed();
    const pagesDispW = pageW * squareCount * currentZoom;
    const pagesDispH = pageH * currentZoom;
    const bleedPx = canvasBleed * currentZoom;
    const dispW = Math.max(1, pagesDispW + bleedPx * 2);
    const dispH = Math.max(1, pagesDispH + bleedPx * 2);
    wrapper.style.transform = 'none';
    wrapper.style.width = dispW + 'px';
    wrapper.style.height = dispH + 'px';
    wrapper.style.marginRight = '0px';
    wrapper.style.marginBottom = '0px';
    if (overlay) {
        overlay.style.left = bleedPx + 'px';
        overlay.style.top = bleedPx + 'px';
        overlay.style.width = (pageW * squareCount) + 'px';
        overlay.style.height = pageH + 'px';
        overlay.style.transform = `scale(${currentZoom})`;
    }
    applyPageFill();
    canvas.backgroundColor = '';
    canvas.setDimensions({ width: dispW, height: dispH });
    applyCanvasViewport();
    canvas.calcOffset();
    document.getElementById('zoom-level').innerText = Math.round(currentZoom * 100) + '%';
    centerStagePadding();
    canvas.requestRenderAll();
}

function centerStagePadding() {
    const workspace = document.getElementById('workspace');
    const stage = document.getElementById('canvas-stage');
    const scaledW = pageW * currentZoom;
    const scaledH = pageH * currentZoom;
    const bleedPx = canvasBleed * currentZoom;
    const totalW = scaledW * squareCount;
    const padX = Math.max(16, (workspace.clientWidth - scaledW) / 2 - bleedPx);
    const padY = Math.max(16, (workspace.clientHeight - scaledH) / 2 - bleedPx);
    stage.style.paddingLeft = padX + 'px';
    stage.style.paddingRight = padX + 'px';
    stage.style.paddingTop = padY + 'px';
    stage.style.paddingBottom = padY + 'px';
    stage.style.width = (totalW + bleedPx * 2 + padX * 2) + 'px';
    stage.style.minHeight = (scaledH + bleedPx * 2 + padY * 2) + 'px';
}

function fitToScreen() {
    const workspace = document.getElementById('workspace');
    const availW = Math.max(120, workspace.clientWidth - 32);
    const availH = Math.max(120, workspace.clientHeight - 32);
    currentZoom = Math.min(availW / pageW, availH / pageH, 1) * FIT_SCALE;
    currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom));
    applyZoom();
    scrollToPage(currentVisiblePage, false);
}

function zoomIn() {
    if (currentZoom < MAX_ZOOM) {
        currentZoom = Math.min(MAX_ZOOM, currentZoom + 0.1);
        applyZoom();
    }
}

function zoomOut() {
    if (currentZoom > MIN_ZOOM) {
        currentZoom = Math.max(MIN_ZOOM, currentZoom - 0.1);
        applyZoom();
    }
}

document.getElementById('workspace').addEventListener('wheel', function(e) {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
    }
}, { passive: false });

window.addEventListener('resize', () => {
    canvas.calcOffset();
    centerStagePadding();
    scrollToPage(currentVisiblePage, false);
    updateMobileHint();
    applyInteractionMode();
    configureAllObjectControls();
});

// --- TOOLBAR FLUTTUANTE ---
function updateToolbarPosition() {
    const activeObj = canvas.getActiveObject();
    const toolbar = document.getElementById('floating-toolbar');
    if (!activeObj || activeObj.isAlignmentLine || pageDrag.active || pageEditorMode) {
        toolbar.style.display = 'none';
        return;
    }
    toolbar.style.display = 'flex';
    const boundingRect = activeObj.getBoundingRect(true);
    toolbar.style.left = (boundingRect.left + boundingRect.width) + 'px';
    toolbar.style.top = boundingRect.top + 'px';
}

function onSelectionControls(e) {
    const obj = e && e.target ? e.target : canvas.getActiveObject();
    if (obj) configureObjectControls(obj);
    if (e && e.selected) e.selected.forEach(configureObjectControls);
    updateToolbarPosition();
}

canvas.on('selection:created', onSelectionControls);
canvas.on('selection:updated', onSelectionControls);
canvas.on('selection:cleared', updateToolbarPosition);
canvas.on('object:moving', updateToolbarPosition);
canvas.on('object:scaling', updateToolbarPosition);
canvas.on('object:rotating', updateToolbarPosition);
canvas.on('object:added', (e) => {
    if (e.target) configureObjectControls(e.target);
    if (pageEditorMode && e.target && !e.target.isGuideLine && !e.target.isAlignmentLine && !e.target.isCropRect) {
        e.target.selectable = false;
        e.target.evented = false;
    }
});

function bringGuidesToFront() {
    canvas.getObjects().forEach(obj => {
        if (obj.isGuideLine) canvas.bringToFront(obj);
    });
}

function changeLayer(action) {
    const obj = canvas.getActiveObject();
    if (!obj || isCropping) return;
    if (action === 'bottom') canvas.sendToBack(obj);
    if (action === 'down') canvas.sendBackwards(obj);
    if (action === 'up') canvas.bringForward(obj);
    if (action === 'top') canvas.bringToFront(obj);
    bringGuidesToFront();
    canvas.renderAll();
    saveState();
}

// --- CROP ---
function startCrop() {
    if (pageEditorMode) return;
    imgToCrop = canvas.getActiveObject();
    if (!imgToCrop || imgToCrop.type !== 'image') {
        alert('Puoi ritagliare solo le immagini.');
        return;
    }
    if (imgToCrop.angle !== 0) {
        imgToCrop.set('angle', 0);
        canvas.renderAll();
    }
    isCropping = true;
    cropRect = new fabric.Rect({
        left: imgToCrop.left,
        top: imgToCrop.top,
        width: imgToCrop.getScaledWidth(),
        height: imgToCrop.getScaledHeight(),
        fill: 'rgba(0, 0, 0, 0.4)',
        stroke: '#ef4444',
        strokeWidth: 2,
        strokeDashArray: [5, 5],
        cornerColor: '#ef4444',
        borderColor: '#ef4444',
        cornerSize: 12,
        transparentCorners: false,
        hasRotatingPoint: false,
        lockRotation: true,
        isCropRect: true
    });
    cropRect.setControlsVisibility({ tlRotate: false, trRotate: false, blRotate: false, brRotate: false });
    canvas.add(cropRect);
    canvas.setActiveObject(cropRect);
    imgToCrop.selectable = false;
    imgToCrop.evented = false;
    document.getElementById('normal-tools').classList.add('hidden');
    document.getElementById('crop-tools').classList.remove('hidden');
    updateToolbarPosition();
}

function applyCrop() {
    if (!isCropping || !cropRect || !imgToCrop) return;
    let scaleX = imgToCrop.scaleX;
    let scaleY = imgToCrop.scaleY;
    let currentCropX = imgToCrop.cropX || 0;
    let currentCropY = imgToCrop.cropY || 0;
    let leftOffset = cropRect.left - imgToCrop.left;
    let topOffset = cropRect.top - imgToCrop.top;
    imgToCrop.set({
        cropX: currentCropX + (leftOffset / scaleX),
        cropY: currentCropY + (topOffset / scaleY),
        width: cropRect.getScaledWidth() / scaleX,
        height: cropRect.getScaledHeight() / scaleY,
        left: cropRect.left,
        top: cropRect.top,
        selectable: true,
        evented: true
    });
    canvas.remove(cropRect);
    isCropping = false;
    cropRect = null;
    document.getElementById('normal-tools').classList.remove('hidden');
    document.getElementById('crop-tools').classList.add('hidden');
    canvas.setActiveObject(imgToCrop);
    canvas.renderAll();
    saveState();
}

function cancelCrop() {
    if (!isCropping) return;
    canvas.remove(cropRect);
    imgToCrop.selectable = true;
    imgToCrop.evented = true;
    isCropping = false;
    cropRect = null;
    document.getElementById('normal-tools').classList.remove('hidden');
    document.getElementById('crop-tools').classList.add('hidden');
    canvas.setActiveObject(imgToCrop);
    canvas.renderAll();
}

// --- PAGINE ---
function getObjectPageIndex(obj) {
    const left = typeof obj.left === 'number' ? obj.left : 0;
    let page = Math.floor(left / pageW);
    if (page < 0) page = 0;
    if (page >= squareCount) page = squareCount - 1;
    return page;
}

function rebuildGuideLines() {
    const prev = isHistoryAction;
    isHistoryAction = true;
    [...guideLines].forEach(line => canvas.remove(line));
    guideLines = [];
    for (let i = 1; i < squareCount; i++) {
        const lineX = pageW * i;
        const line = new fabric.Line([lineX, 0, lineX, pageH], {
            stroke: 'rgba(0,0,0,0.35)',
            strokeWidth: 2,
            strokeDashArray: [15, 15],
            selectable: false,
            evented: false,
            isGuideLine: true
        });
        guideLines.push(line);
        canvas.add(line);
    }
    bringGuidesToFront();
    isHistoryAction = prev;
}

function syncCanvasSize() {
    document.getElementById('square-badge').innerText = squareCount;
    rebuildGuideLines();
    applyZoom();
    renderPagesUI();
    renderRuleGrid();
    renderPageEditorFrames();
    updateMobileHint();
}

function updateAspectToggleUI() {
    document.querySelectorAll('#aspect-toggle .aspect-btn').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.aspect === aspectRatio);
    });
}

function toggleRuleGrid() {
    showRuleGrid = !showRuleGrid;
    const btn = document.getElementById('btn-grid');
    btn.classList.toggle('is-active', showRuleGrid);
    btn.setAttribute('aria-pressed', showRuleGrid ? 'true' : 'false');
    renderRuleGrid();
}

function renderRuleGrid() {
    const el = document.getElementById('rule-grid');
    if (!el) return;
    el.innerHTML = '';
    if (!showRuleGrid) {
        el.classList.remove('show');
        return;
    }
    el.classList.add('show');
    el.style.width = (pageW * squareCount) + 'px';
    el.style.height = pageH + 'px';
    for (let i = 0; i < squareCount; i++) {
        const page = document.createElement('div');
        page.className = 'rule-grid-page';
        page.style.left = (i * pageW) + 'px';
        page.style.width = pageW + 'px';
        page.style.height = pageH + 'px';
        page.innerHTML = `
            <div class="v" style="left:33.333%"></div>
            <div class="v" style="left:66.666%"></div>
            <div class="h" style="top:33.333%"></div>
            <div class="h" style="top:66.666%"></div>
        `;
        el.appendChild(page);
    }
}

/**
 * Cambia formato pagina: verticale 4:5, quadrato 1:1, orizzontale 1.91:1.
 * Rimappa posizione e scala degli oggetti rispetto alle nuove dimensioni.
 */
function setAspectRatio(next) {
    next = resolveAspectKey(next);
    if (!ASPECT_PRESETS[next] || isCropping || pageDrag.active || pinchGesture.active) return;
    if (next === aspectRatio) {
        updateAspectToggleUI();
        return;
    }

    const oldW = pageW;
    const oldH = pageH;
    aspectRatio = next;
    pageW = ASPECT_PRESETS[next].w;
    pageH = ASPECT_PRESETS[next].h;
    updateAspectToggleUI();

    const sx = pageW / oldW;
    const sy = pageH / oldH;
    const scale = Math.min(sx, sy);

    isHistoryAction = true;
    canvas.getObjects().forEach(obj => {
        if (obj.isGuideLine || obj.isAlignmentLine || obj.isCropRect) return;
        let page = Math.floor(obj.left / oldW);
        if (page < 0) page = 0;
        if (page >= squareCount) page = squareCount - 1;
        const offsetX = obj.left - page * oldW;
        const offsetY = obj.top || 0;
        obj.set({
            left: page * pageW + offsetX * sx,
            top: offsetY * sy,
            scaleX: (obj.scaleX || 1) * scale,
            scaleY: (obj.scaleY || 1) * scale
        });
        obj.setCoords();
    });
    isHistoryAction = false;

    syncCanvasSize();
    canvas.discardActiveObject();
    canvas.renderAll();
    fitToScreen();
    saveState();
}

function movePage(fromIndex, toIndex) {
    if (isCropping) return;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= squareCount || toIndex >= squareCount) return;

    const content = canvas.getObjects().filter(o =>
        !o.isGuideLine && !o.isAlignmentLine && !o.isCropRect
    );

    const snapshots = content.map(obj => {
        const page = getObjectPageIndex(obj);
        return { obj, page, offsetX: obj.left - page * pageW, top: obj.top };
    });

    const order = Array.from({ length: squareCount }, (_, i) => i);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);

    const newIndexOf = {};
    order.forEach((oldIdx, newIdx) => { newIndexOf[oldIdx] = newIdx; });

    snapshots.forEach(({ obj, page, offsetX, top }) => {
        obj.set({ left: newIndexOf[page] * pageW + offsetX, top });
        obj.setCoords();
    });

    canvas.discardActiveObject();
    canvas.renderAll();
    updateToolbarPosition();
    renderPagesUI();
    renderPageEditorFrames();
    saveState();
    scrollToPage(toIndex, true);
}

function deletePage(index) {
    if (isCropping || pageDrag.active) return;
    if (squareCount <= 1) {
        alert('Serve almeno una pagina.');
        return;
    }
    if (!confirm(`Eliminare la pagina ${index + 1}? Le immagini di quella pagina verranno rimosse.`)) return;

    const content = canvas.getObjects().filter(o =>
        !o.isGuideLine && !o.isAlignmentLine && !o.isCropRect
    );

    isHistoryAction = true;
    content.forEach(obj => {
        const page = getObjectPageIndex(obj);
        if (page === index) canvas.remove(obj);
        else if (page > index) {
            obj.set({ left: obj.left - pageW });
            obj.setCoords();
        }
    });
    squareCount--;
    syncCanvasSize();
    canvas.renderAll();
    isHistoryAction = false;
    saveState();
    currentVisiblePage = Math.min(currentVisiblePage, squareCount - 1);
    scrollToPage(currentVisiblePage, true);
}

function deleteCurrentPage() {
    deletePage(currentVisiblePage);
}

function renderPagesUI() {
    const dots = document.getElementById('pages-dots');
    dots.innerHTML = '';
    for (let i = 0; i < squareCount; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'page-dot' + (i === currentVisiblePage ? ' active' : '');
        dot.setAttribute('aria-label', 'Vai a pagina ' + (i + 1));
        dot.addEventListener('click', () => scrollToPage(i, true));
        dots.appendChild(dot);
    }
    document.getElementById('page-label').textContent = `Pagina ${currentVisiblePage + 1} / ${squareCount}`;
    document.getElementById('btn-delete-page').disabled = squareCount <= 1;
}

function scrollToPage(index, smooth) {
    index = Math.max(0, Math.min(squareCount - 1, index));
    currentVisiblePage = index;
    const workspace = document.getElementById('workspace');
    const stage = document.getElementById('canvas-stage');
    const padX = parseFloat(stage.style.paddingLeft) || 0;
    const padY = parseFloat(stage.style.paddingTop) || 0;
    const bleedPx = canvasBleed * currentZoom;
    const pageDispW = pageW * currentZoom;
    const pageDispH = pageH * currentZoom;
    const targetLeft = padX + bleedPx + index * pageDispW - (workspace.clientWidth - pageDispW) / 2;
    const targetTop = padY + bleedPx - (workspace.clientHeight - pageDispH) / 2;
    workspace.scrollTo({
        left: Math.max(0, targetLeft),
        top: Math.max(0, targetTop),
        behavior: smooth ? 'smooth' : 'auto'
    });
    renderPagesUI();
}

function updateVisiblePageFromScroll() {
    const workspace = document.getElementById('workspace');
    const stage = document.getElementById('canvas-stage');
    const padX = parseFloat(stage.style.paddingLeft) || 0;
    const bleedPx = canvasBleed * currentZoom;
    const centerX = workspace.scrollLeft + workspace.clientWidth / 2 - padX - bleedPx;
    const page = Math.round(centerX / (pageW * currentZoom) - 0.5);
    const clamped = Math.max(0, Math.min(squareCount - 1, page));
    if (clamped !== currentVisiblePage) {
        currentVisiblePage = clamped;
        renderPagesUI();
    }
}

document.getElementById('workspace').addEventListener('scroll', () => {
    const workspace = document.getElementById('workspace');
    if (scrollLock.active) {
        workspace.scrollLeft = scrollLock.left;
        workspace.scrollTop = scrollLock.top;
        return;
    }
    canvas.calcOffset();
    if (!pageDrag.active) updateVisiblePageFromScroll();
}, { passive: true });

// --- LONG PRESS PAGE DRAG ---
function clientPoint(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

function isBackgroundTarget(target) {
    return !target || target.isGuideLine;
}

function cancelLongPressArm() {
    if (pageDrag.timer) {
        clearTimeout(pageDrag.timer);
        pageDrag.timer = null;
    }
    if (pageDrag.ringTimer) {
        clearTimeout(pageDrag.ringTimer);
        pageDrag.ringTimer = null;
    }
    pageDrag.armed = false;
    document.getElementById('longpress-ring').classList.remove('show');
}

function showLongPressRing(x, y) {
    const ring = document.getElementById('longpress-ring');
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    ring.classList.add('show');
}

function beginViewPan() {
    viewPan.pending = false;
    viewPan.active = true;
    document.body.classList.add('view-panning');
    if (canvas._currentTransform) canvas._currentTransform = null;
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    updateToolbarPosition();
}

function updateViewPan(pt) {
    if (!viewPan.active) return;
    const workspace = document.getElementById('workspace');
    workspace.scrollLeft = viewPan.startScrollLeft - (pt.x - viewPan.startClientX);
    workspace.scrollTop = viewPan.startScrollTop - (pt.y - viewPan.startClientY);
}

function endViewPan() {
    viewPan.pending = false;
    if (!viewPan.active) return;
    viewPan.active = false;
    document.body.classList.remove('view-panning');
}

/**
 * Anteprima drag: solo oggetti che appartengono alla pagina
 * (angolo in alto a sinistra), non lo screenshot dell'area.
 * Così le immagini "a metà" della pagina vicina non compaiono.
 */
function capturePageOwnedPreview(pageIndex) {
    const states = canvas.getObjects().map(o => ({
        obj: o,
        visible: o.visible !== false,
        opacity: o.opacity
    }));

    canvas.getObjects().forEach(o => {
        if (o.isGuideLine || o.isAlignmentLine || o.isCropRect) {
            o.visible = false;
            return;
        }
        o.visible = getObjectPageIndex(o) === pageIndex;
    });
    canvas.renderAll();

    const dataURL = canvas.toDataURL({
        format: 'png',
        left: (canvasBleed + pageIndex * pageW) * currentZoom,
        top: canvasBleed * currentZoom,
        width: pageW * currentZoom,
        height: pageH * currentZoom,
        enableRetinaScaling: false
    });

    states.forEach(({ obj, visible, opacity }) => {
        obj.visible = visible;
        obj.opacity = opacity;
    });
    canvas.renderAll();
    return dataURL;
}

function setOwnedObjectsLifted(pageIndex, lifted) {
    canvas.getObjects().forEach(o => {
        if (o.isGuideLine || o.isAlignmentLine || o.isCropRect) return;
        if (getObjectPageIndex(o) === pageIndex) {
            o.visible = !lifted;
        }
    });
    canvas.renderAll();
}

function startPageDrag(fromIndex, clientX, clientY) {
    if (squareCount < 2 || isCropping) {
        cancelLongPressArm();
        return;
    }
    pageDrag.armed = false;
    pageDrag.timer = null;
    pageDrag.active = true;
    pageDrag.fromIndex = fromIndex;
    pageDrag.insertAt = fromIndex;

    document.getElementById('longpress-ring').classList.remove('show');
    document.body.classList.add('page-dragging');
    canvas.discardActiveObject();
    canvas.selection = false;
    canvas.forEachObject(o => {
        if (!o.isGuideLine) {
            o.selectable = false;
            o.evented = false;
        }
    });
    updateToolbarPosition();

    const dataURL = capturePageOwnedPreview(fromIndex);

    // Solleva gli elementi della pagina (restano visibili quelli della pagina vicina)
    setOwnedObjectsLifted(fromIndex, true);

    const ghost = document.getElementById('page-ghost');
    const ghostScale = Math.min(200 / pageW, 200 / pageH, currentZoom * 0.5);
    ghost.style.width = Math.round(pageW * ghostScale) + 'px';
    ghost.style.height = Math.round(pageH * ghostScale) + 'px';
    ghost.querySelector('img').src = dataURL;
    ghost.classList.add('show');
    ghost.style.left = clientX + 'px';
    ghost.style.top = clientY + 'px';

    // Evidenzia lo slot vuoto della pagina (senza coprire elementi vicini)
    const dim = document.getElementById('page-drag-dim');
    dim.style.left = (fromIndex * pageW) + 'px';
    dim.style.width = pageW + 'px';
    dim.classList.add('show');

    if (navigator.vibrate) navigator.vibrate(25);

    updatePageDragVisuals(clientX);
}

function insertionIndexFromClientX(clientX) {
    const wrapper = document.getElementById('canvas-wrapper');
    const rect = wrapper.getBoundingClientRect();
    // x in coordinate canvas non scalate
    const xCanvas = (clientX - rect.left) / currentZoom;
    // slot: 0 prima della prima, ..., squareCount dopo l'ultima
    let slot = Math.round(xCanvas / pageW);
    slot = Math.max(0, Math.min(squareCount, slot));
    return slot;
}

function updatePageDragVisuals(clientX) {
    const ghost = document.getElementById('page-ghost');
    // left/top aggiornati dal move handler

    let slot = insertionIndexFromClientX(clientX);
    // Converti slot (0..N) in destinazione finale dopo rimozione di from
    pageDrag.insertAt = slot;

    const line = document.getElementById('page-insert-line');
    line.style.left = (slot * pageW) + 'px';
    line.classList.add('show');
}

function finishPageDrag() {
    if (!pageDrag.active) return;

    const from = pageDrag.fromIndex;
    let slot = pageDrag.insertAt; // 0..squareCount
    let to = slot;
    if (from < slot) to = slot - 1;
    to = Math.max(0, Math.min(squareCount - 1, to));

    endPageDragUI();
    if (from !== to) movePage(from, to);
}

function endPageDragUI() {
    pageDrag.active = false;
    pageDrag.armed = false;
    pageDrag.timer = null;
    pageDrag.fromIndex = null;
    document.body.classList.remove('page-dragging');
    document.getElementById('page-ghost').classList.remove('show');
    document.getElementById('page-insert-line').classList.remove('show');
    document.getElementById('page-drag-dim').classList.remove('show');
    document.getElementById('longpress-ring').classList.remove('show');

    // Ripristina visibilità di eventuali oggetti "sollevati"
    canvas.getObjects().forEach(o => {
        if (o.isGuideLine || o.isAlignmentLine || o.isCropRect) return;
        o.visible = true;
    });
    applyObjectLockState();
    canvas.renderAll();
}

function cancelPageDrag() {
    cancelLongPressArm();
    endViewPan();
    if (pageDrag.active) {
        endPageDragUI();
        canvas.renderAll();
    }
}

canvas.on('mouse:down', function(opt) {
    if (isCropping || pageDrag.active || pinchGesture.active || viewPan.active) return;

    const pt = clientPoint(opt.e);
    const workspace = document.getElementById('workspace');
    const pointer = canvas.getPointer(opt.e);
    const pageIndex = Math.max(0, Math.min(squareCount - 1, Math.floor(pointer.x / pageW)));

    // Page editor: il drag sposta le pagine, non le foto
    if (pageEditorMode) {
        if (squareCount < 2) return;
        pageDrag.startClientX = pt.x;
        pageDrag.startClientY = pt.y;
        pageDrag.fromIndex = pageIndex;
        pageDrag.armed = true;
        viewPan.pending = false;
        return;
    }

    if (!isBackgroundTarget(opt.target)) {
        beginScrollLock();
        return;
    }

    pageDrag.startClientX = pt.x;
    pageDrag.startClientY = pt.y;
    pageDrag.fromIndex = pageIndex;

    // Pan con drag veloce: solo mobile (su PC il drag serve alla selezione multipla)
    if (isMobileUI()) {
        viewPan.pending = true;
        viewPan.startClientX = pt.x;
        viewPan.startClientY = pt.y;
        viewPan.startScrollLeft = workspace.scrollLeft;
        viewPan.startScrollTop = workspace.scrollTop;
    } else {
        viewPan.pending = false;
    }
});

canvas.on('mouse:move', function(opt) {
    const pt = clientPoint(opt.e);

    if (viewPan.active) {
        updateViewPan(pt);
        return;
    }

    if ((pageDrag.armed || viewPan.pending) && !pageDrag.active) {
        const startX = pageEditorMode ? pageDrag.startClientX : (viewPan.pending ? viewPan.startClientX : pageDrag.startClientX);
        const startY = pageEditorMode ? pageDrag.startClientY : (viewPan.pending ? viewPan.startClientY : pageDrag.startClientY);
        const dx = pt.x - startX;
        const dy = pt.y - startY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOL) {
            if (pageEditorMode && pageDrag.armed) {
                startPageDrag(pageDrag.fromIndex, pageDrag.startClientX, pageDrag.startClientY);
                const ghost = document.getElementById('page-ghost');
                ghost.style.left = pt.x + 'px';
                ghost.style.top = pt.y + 'px';
                updatePageDragVisuals(pt.x);
                return;
            }
            cancelLongPressArm();
            if (viewPan.pending && isMobileUI()) {
                beginViewPan();
                updateViewPan(pt);
            } else {
                viewPan.pending = false;
            }
        }
        return;
    }

    if (pageDrag.active) {
        const ghost = document.getElementById('page-ghost');
        ghost.style.left = pt.x + 'px';
        ghost.style.top = pt.y + 'px';
        updatePageDragVisuals(pt.x);

        const workspace = document.getElementById('workspace');
        const edge = 48;
        if (pt.x < edge) workspace.scrollLeft -= 18;
        else if (pt.x > window.innerWidth - edge) workspace.scrollLeft += 18;
    }
});

function onPointerUp() {
    endScrollLock();
    if (viewPan.active || viewPan.pending) {
        endViewPan();
    }
    if (pageDrag.armed && !pageDrag.active) {
        cancelLongPressArm();
        return;
    }
    if (pageDrag.active) finishPageDrag();
    ensureCanvasBleed({ allowShrink: true });
}

canvas.on('mouse:up', onPointerUp);
canvas.on('mouse:out', function() {
    if (pageDrag.armed && !pageDrag.active && !viewPan.active) cancelLongPressArm();
});

// Evita menu contestuale durante long-press / pan
document.getElementById('canvas-wrapper').addEventListener('contextmenu', (e) => {
    if (pageDrag.armed || pageDrag.active || pinchGesture.active || viewPan.active) e.preventDefault();
});

// --- MULTITOUCH: pinch (scale) + rotate su oggetto selezionato (mobile) ---
function touchDistance(t1, t2) {
    return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
}

function touchAngleDeg(t1, t2) {
    return Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX) * 180 / Math.PI;
}

function clientToCanvasCoords(clientX, clientY) {
    const wrapper = document.getElementById('canvas-wrapper');
    const rect = wrapper.getBoundingClientRect();
    return {
        x: (clientX - rect.left) / currentZoom - canvasBleed,
        y: (clientY - rect.top) / currentZoom - canvasBleed
    };
}

function beginPinchGesture(t1, t2) {
    if (pageEditorMode) return false;
    const obj = canvas.getActiveObject();
    if (!obj || obj.isGuideLine || obj.isAlignmentLine) return false;
    // In crop: pinch solo sul rettangolo di ritaglio
    if (isCropping && !obj.isCropRect) return false;

    cancelLongPressArm();
    if (canvas._currentTransform) {
        canvas._currentTransform = null;
    }

    const mid = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
    };

    pinchGesture.active = true;
    pinchGesture.obj = obj;
    beginScrollLock();
    pinchGesture.startDist = Math.max(1, touchDistance(t1, t2));
    pinchGesture.startAngle = touchAngleDeg(t1, t2);
    pinchGesture.baseScaleX = obj.scaleX || 1;
    pinchGesture.baseScaleY = obj.scaleY || 1;
    pinchGesture.baseAngle = obj.isCropRect ? 0 : (obj.angle || 0);
    pinchGesture.startMidCanvas = clientToCanvasCoords(mid.x, mid.y);
    pinchGesture.baseCenter = obj.getCenterPoint();
    return true;
}

function updatePinchGesture(t1, t2) {
    if (!pinchGesture.active || !pinchGesture.obj) return;
    const obj = pinchGesture.obj;
    const dist = Math.max(1, touchDistance(t1, t2));
    const factor = dist / pinchGesture.startDist;

    const scaleX = Math.max(0.05, pinchGesture.baseScaleX * factor);
    const scaleY = Math.max(0.05, pinchGesture.baseScaleY * factor);

    if (obj.isCropRect) {
        // Crop: solo scale uniforme, niente rotazione
        obj.set({ scaleX, scaleY, angle: 0 });
    } else {
        let angle = pinchGesture.baseAngle + (touchAngleDeg(t1, t2) - pinchGesture.startAngle);
        const snapped = Math.round(angle / 5) * 5;
        if (Math.abs(angle - snapped) < 3) angle = snapped;
        obj.set({ scaleX, scaleY, angle });
    }

    const mid = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
    };
    const midCanvas = clientToCanvasCoords(mid.x, mid.y);
    const dx = midCanvas.x - pinchGesture.startMidCanvas.x;
    const dy = midCanvas.y - pinchGesture.startMidCanvas.y;
    obj.setPositionByOrigin(
        new fabric.Point(pinchGesture.baseCenter.x + dx, pinchGesture.baseCenter.y + dy),
        'center',
        'center'
    );
    obj.setCoords();
    canvas.requestRenderAll();
    updateToolbarPosition();
}

function endPinchGesture(commit) {
    if (!pinchGesture.active) return;
    const obj = pinchGesture.obj;
    pinchGesture.active = false;
    pinchGesture.obj = null;
    endScrollLock();
    if (commit && obj) {
        obj.setCoords();
        // object:modified → saveState automatico
        canvas.fire('object:modified', { target: obj });
    }
    canvas.requestRenderAll();
    updateToolbarPosition();
}

const upperCanvas = canvas.upperCanvasEl;

upperCanvas.addEventListener('touchstart', (e) => {
    if (!isMobileUI()) return;

    if (e.touches.length >= 2) {
        if (beginPinchGesture(e.touches[0], e.touches[1])) {
            e.preventDefault();
            e.stopPropagation();
        }
    }
}, { passive: false, capture: true });

upperCanvas.addEventListener('touchmove', (e) => {
    if (pinchGesture.active && e.touches.length >= 2) {
        e.preventDefault();
        e.stopPropagation();
        updatePinchGesture(e.touches[0], e.touches[1]);
        return;
    }
    // Sempre: il drag di una foto non deve scrollare lo workspace
    e.preventDefault();
}, { passive: false, capture: true });

upperCanvas.addEventListener('touchend', (e) => {
    if (pinchGesture.active) {
        if (e.touches.length < 2) {
            e.preventDefault();
            endPinchGesture(true);
        }
        return;
    }
    onPointerUp();
}, { passive: false, capture: true });

upperCanvas.addEventListener('touchcancel', () => {
    if (pinchGesture.active) endPinchGesture(false);
    endScrollLock();
    cancelPageDrag();
}, { capture: true });

// --- BG / UPLOAD / DELETE ---
document.getElementById('bg-color').addEventListener('input', function(e) {
    const color = e.target.value;
    document.getElementById('bg-color-icon').style.backgroundColor = color;
    applyPageFill();
});
document.getElementById('bg-color').addEventListener('change', saveState);

function addSquare() {
    squareCount++;
    syncCanvasSize();
    canvas.renderAll();
    saveState();
    scrollToPage(squareCount - 1, true);
}

function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('decode failed'));
        };
        img.src = url;
    });
}

function loadHtmlImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = src;
    });
}

function rasterizeImageElement(img, maxShortSide, quality) {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    const shortSide = Math.min(srcW, srcH) || 1;
    let w = srcW;
    let h = srcH;
    if (shortSide > maxShortSide) {
        const scale = maxShortSide / shortSide;
        w = Math.max(1, Math.round(srcW * scale));
        h = Math.max(1, Math.round(srcH * scale));
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return {
        dataURL: c.toDataURL('image/jpeg', quality),
        width: w,
        height: h
    };
}

function dataURLToBlob(dataURL) {
    const parts = String(dataURL).split(',');
    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(parts[1] || '');
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsDataURL(blob);
    });
}

function newHiResId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function openHiResDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('IndexedDB non disponibile'));
            return;
        }
        const req = indexedDB.open(HIRES_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(HIRES_STORE)) {
                db.createObjectStore(HIRES_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function putHiResBlob(id, blob) {
    const db = await openHiResDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(HIRES_STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(HIRES_STORE).put(blob, id);
    });
}

async function getHiResBlob(id) {
    if (!id) return null;
    try {
        const db = await openHiResDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(HIRES_STORE, 'readonly');
            const req = tx.objectStore(HIRES_STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (err) {
        console.warn('Lettura hi-res fallita', err);
        return null;
    }
}

function collectHiResIdsFromJson(json, into) {
    const ids = into || new Set();
    const walk = (objs) => {
        (objs || []).forEach(o => {
            if (o && o.hiResId) ids.add(o.hiResId);
            if (o && o.objects) walk(o.objects);
        });
    };
    walk(json && json.objects);
    return ids;
}

function collectAllKnownHiResIds() {
    const ids = new Set();
    canvas.getObjects().forEach(o => {
        if (o.hiResId) ids.add(o.hiResId);
    });
    historyStack.forEach(state => collectHiResIdsFromJson(state.json, ids));
    return ids;
}

async function pruneHiResStore() {
    try {
        const keep = collectAllKnownHiResIds();
        const db = await openHiResDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(HIRES_STORE, 'readwrite');
            const store = tx.objectStore(HIRES_STORE);
            const req = store.getAllKeys();
            req.onsuccess = () => {
                (req.result || []).forEach(key => {
                    if (!keep.has(key)) store.delete(key);
                });
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        // private mode / IDB pieno: l'anteprima resta comunque usabile
    }
}

async function importHiResMap(map) {
    if (!map || typeof map !== 'object') return;
    for (const [id, dataURL] of Object.entries(map)) {
        if (!id || !dataURL) continue;
        try {
            await putHiResBlob(id, dataURLToBlob(dataURL));
        } catch (err) {
            console.warn('Import hi-res fallito', id, err);
        }
    }
}

async function collectHiResDataUrls() {
    const map = {};
    const ids = new Set();
    canvas.getObjects().forEach(o => { if (o.hiResId) ids.add(o.hiResId); });
    for (const id of ids) {
        const blob = await getHiResBlob(id);
        if (blob) map[id] = await blobToDataURL(blob);
    }
    return map;
}

async function prepareImageForCanvas(file) {
    const source = await loadImageFromFile(file);
    const srcW = source.naturalWidth || source.width;
    const srcH = source.naturalHeight || source.height;
    const shortSide = Math.min(srcW, srcH) || 1;
    const mobile = isMobileUI();

    if (!mobile) {
        if (shortSide <= MAX_IMAGE_SHORT_SIDE) {
            return {
                dataURL: await blobToDataURL(file),
                hiResId: null,
                proxyNaturalWidth: srcW,
                proxyNaturalHeight: srcH
            };
        }
        const display = rasterizeImageElement(source, MAX_IMAGE_SHORT_SIDE, 0.92);
        return {
            dataURL: display.dataURL,
            hiResId: null,
            proxyNaturalWidth: display.width,
            proxyNaturalHeight: display.height
        };
    }

    if (shortSide <= PROXY_SHORT_SIDE) {
        return {
            dataURL: await blobToDataURL(file),
            hiResId: null,
            proxyNaturalWidth: srcW,
            proxyNaturalHeight: srcH
        };
    }

    const display = rasterizeImageElement(source, PROXY_SHORT_SIDE, 0.82);

    const hi = rasterizeImageElement(source, HIRES_SHORT_SIDE, 0.92);
    const hiResId = newHiResId();
    try {
        await putHiResBlob(hiResId, dataURLToBlob(hi.dataURL));
        return {
            dataURL: display.dataURL,
            hiResId,
            proxyNaturalWidth: display.width,
            proxyNaturalHeight: display.height
        };
    } catch (err) {
        console.warn('IndexedDB hi-res non disponibile, uso qualità export in canvas', err);
        return {
            dataURL: hi.dataURL,
            hiResId: null,
            proxyNaturalWidth: hi.width,
            proxyNaturalHeight: hi.height
        };
    }
}

async function withHighResSources(fn) {
    const backups = [];
    const images = canvas.getObjects().filter(o => o.type === 'image' && o.hiResId);
    try {
        for (const img of images) {
            const blob = await getHiResBlob(img.hiResId);
            if (!blob) continue;
            const objectUrl = URL.createObjectURL(blob);
            const hiEl = await loadHtmlImage(objectUrl);
            const proxyW = img.proxyNaturalWidth || (img._originalElement && img._originalElement.naturalWidth) || img.width;
            const proxyH = img.proxyNaturalHeight || (img._originalElement && img._originalElement.naturalHeight) || img.height;
            const rx = (hiEl.naturalWidth || hiEl.width) / proxyW;
            const ry = (hiEl.naturalHeight || hiEl.height) / proxyH;
            if (!isFinite(rx) || !isFinite(ry) || rx <= 0 || ry <= 0) {
                URL.revokeObjectURL(objectUrl);
                continue;
            }
            const backup = {
                img,
                element: img._element,
                originalElement: img._originalElement,
                cropX: img.cropX || 0,
                cropY: img.cropY || 0,
                width: img.width,
                height: img.height,
                scaleX: img.scaleX,
                scaleY: img.scaleY,
                left: img.left,
                top: img.top,
                objectUrl
            };
            backups.push(backup);
            img.setElement(hiEl);
            img.set({
                left: backup.left,
                top: backup.top,
                cropX: backup.cropX * rx,
                cropY: backup.cropY * ry,
                width: backup.width * rx,
                height: backup.height * ry,
                scaleX: backup.scaleX / rx,
                scaleY: backup.scaleY / ry
            });
            img.dirty = true;
            img.setCoords();
        }
        canvas.renderAll();
        await fn();
    } finally {
        backups.forEach(backup => {
            try {
                backup.img.setElement(backup.originalElement || backup.element);
                backup.img.set({
                    left: backup.left,
                    top: backup.top,
                    cropX: backup.cropX,
                    cropY: backup.cropY,
                    width: backup.width,
                    height: backup.height,
                    scaleX: backup.scaleX,
                    scaleY: backup.scaleY
                });
                backup.img.dirty = true;
                backup.img.setCoords();
            } catch (err) {
                console.warn('Ripristino proxy fallito', err);
            }
            URL.revokeObjectURL(backup.objectUrl);
        });
        canvas.renderAll();
    }
}

async function withNativeCanvasResolution(fn) {
    const bg = getPageBgColor();
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.setDimensions({ width: pageW * squareCount, height: pageH });
    canvas.backgroundColor = bg;
    canvas.renderAll();
    try {
        return await fn();
    } finally {
        canvas.backgroundColor = '';
        applyZoom();
    }
}

function placeFabricImageOnCurrentPage(img, extra) {
    const baseLeft = currentVisiblePage * pageW;
    const maxDim = Math.max(img.width, img.height) || 1;
    const fit = (Math.min(pageW, pageH) * 0.9) / maxDim;
    if (fit < 1) img.scale(fit);
    img.set({
        left: baseLeft + (pageW / 2) - (img.getScaledWidth() / 2),
        top: (pageH / 2) - (img.getScaledHeight() / 2),
        ...(extra || {})
    });
    canvas.add(img);
    canvas.setActiveObject(img);
    configureObjectControls(img);
    canvas.requestRenderAll();
}

document.getElementById('image-upload').addEventListener('change', async function(e) {
    const files = e.target.files;
    if (!files.length) return;
    if (typeof fabric === 'undefined' || !canvas) {
        alert('Editor non pronto. Ricarica la pagina.');
        return;
    }
    if (pageEditorMode) setPageEditorMode(false);
    const fileList = Array.from(files);
    e.target.value = '';
    const hint = document.getElementById('hint-toast');
    if (hint) hint.textContent = 'Caricamento foto…';

    for (let i = 0; i < fileList.length; i++) {
        try {
            const prepared = await prepareImageForCanvas(fileList[i]);
            await new Promise((resolve, reject) => {
                fabric.Image.fromURL(prepared.dataURL, function(img) {
                    try {
                        if (!img || typeof img.width !== 'number') {
                            reject(new Error('Immagine non decodificata'));
                            return;
                        }
                        placeFabricImageOnCurrentPage(img, {
                            hiResId: prepared.hiResId || undefined,
                            proxyNaturalWidth: prepared.proxyNaturalWidth,
                            proxyNaturalHeight: prepared.proxyNaturalHeight
                        });
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });
        } catch (err) {
            console.warn('Caricamento immagine fallito', err);
        }
    }
    updateMobileHint();
});

function deleteSelected() {
    if (isCropping || pageDrag.active || pageEditorMode) return;
    const activeObjects = canvas.getActiveObjects();
    if (activeObjects.length) {
        canvas.discardActiveObject();
        activeObjects.forEach(object => canvas.remove(object));
    }
}

window.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
        if (pinchGesture.active) endPinchGesture(false);
        if (pageEditorMode) {
            setPageEditorMode(false);
            return;
        }
        const libModal = document.getElementById('library-modal');
        if (libModal && !libModal.classList.contains('hidden')) {
            closeLibraryModal();
            return;
        }
        cancelPageDrag();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        const libModal = document.getElementById('library-modal');
        if (libModal && !libModal.classList.contains('hidden')) return;
        deleteSelected();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); changeLayer('up'); }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); changeLayer('down'); }
});

async function exportCarousel() {
    if (isExporting || isCropping || pageDrag.active) return;
    isExporting = true;
    const hint = document.getElementById('hint-toast');
    if (hint && !pageEditorMode) hint.textContent = 'Esportazione in alta risoluzione…';
    try {
        await withHighResSources(async () => {
            await withNativeCanvasResolution(async () => {
                guideLines.forEach(line => line.set('opacity', 0));
                canvas.discardActiveObject();
                canvas.renderAll();
                for (let i = 0; i < squareCount; i++) {
                    const dataURL = canvas.toDataURL({
                        format: 'jpeg', quality: 1,
                        left: i * pageW, top: 0, width: pageW, height: pageH,
                        enableRetinaScaling: false
                    });
                    const link = document.createElement('a');
                    link.download = `carousel-slide-${i + 1}.jpg`;
                    link.href = dataURL;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    await new Promise(r => setTimeout(r, 180));
                }
                guideLines.forEach(line => line.set('opacity', 1));
                canvas.renderAll();
            });
        });
    } catch (err) {
        console.warn('Export fallito', err);
        alert('Esportazione non riuscita.');
    } finally {
        isExporting = false;
        updateMobileHint();
    }
}

// --- PERSISTENZA & PROGETTO ---
function buildProjectPayload() {
    return {
        type: PROJECT_TYPE,
        version: PROJECT_VERSION,
        squareCount,
        aspectRatio,
        backgroundColor: getPageBgColor(),
        // Fabric serializza le immagini come data URL (base64): un solo file portatile
        json: canvas.toJSON(FABRIC_JSON_PROPS),
        savedAt: Date.now()
    };
}

function stripEmbeddedHiRes(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { json, hiRes: undefined };
    }
    if (!json._carouselHiRes) return { json, hiRes: undefined };
    const clone = { ...json };
    const hiRes = clone._carouselHiRes;
    delete clone._carouselHiRes;
    return { json: clone, hiRes };
}

function applyProjectPayload(payload, { resetHistory = true } = {}) {
    return new Promise((resolve, reject) => {
        if (!payload || !payload.json) {
            reject(new Error('Progetto non valido'));
            return;
        }

        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            isHistoryAction = false;
            fn(value);
        };

        const timeout = setTimeout(() => {
            finish(reject, new Error('Timeout ripristino progetto'));
        }, 20000);

        try {
            isHistoryAction = true;
            if (isCropping) cancelCrop();
            cancelPageDrag();
            if (pageEditorMode) setPageEditorMode(false);
            if (typeof endPinchGesture === 'function') endPinchGesture(false);

            const extracted = stripEmbeddedHiRes(payload.json);
            const json = extracted.json;
            const hiRes = payload.hiRes || extracted.hiRes;

            canvas.loadFromJSON(json, async function() {
                try {
                    squareCount = payload.squareCount || 1;
                    aspectRatio = resolveAspectKey(payload.aspectRatio || '1:1');
                    pageW = ASPECT_PRESETS[aspectRatio].w;
                    pageH = ASPECT_PRESETS[aspectRatio].h;
                    updateAspectToggleUI();

                    if (payload.backgroundColor) {
                        document.getElementById('bg-color').value = payload.backgroundColor;
                        document.getElementById('bg-color-icon').style.backgroundColor = payload.backgroundColor;
                    }
                    canvas.backgroundColor = '';

                    if (hiRes) {
                        await importHiResMap(hiRes);
                    }

                    syncCanvasSize();
                    guideLines = canvas.getObjects().filter(o => o.isGuideLine);
                    if (guideLines.length !== Math.max(0, squareCount - 1)) rebuildGuideLines();
                    canvas.discardActiveObject();
                    canvas.renderAll();
                    if (resetHistory) initHistory();
                    else persistProject();
                    fitToScreen();
                    applyInteractionMode();
                    configureAllObjectControls();
                    applyObjectLockState();
                    updateMobileHint();
                    updateToolbarPosition();
                    finish(resolve);
                } catch (err) {
                    finish(reject, err);
                }
            });
        } catch (err) {
            finish(reject, err);
        }
    });
}

function persistProject() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildProjectPayload()));
    } catch (err) {
        console.warn('Autosave non disponibile (quota o private mode)', err);
    }
    pruneHiResStore();
}

async function restoreProject() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const payload = JSON.parse(raw);
        if (!payload || !payload.json) return false;
        await applyProjectPayload(payload, { resetHistory: true });
        return true;
    } catch (err) {
        console.warn('Ripristino fallito, reset autosave', err);
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        isHistoryAction = false;
        return false;
    }
}

async function saveProjectFile() {
    if (isCropping || pageDrag.active) return;
    try {
        const payload = buildProjectPayload();
        payload.hiRes = await collectHiResDataUrls();
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const link = document.createElement('a');
        // .CMF = Carousel Maker File (JSON sotto il cofano; estensione solo estetica)
        link.download = `carousel-progetto-${stamp}.cmf`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('Progetto scaricato (.CMF)');
    } catch (err) {
        console.warn('Salvataggio progetto fallito', err);
        alert('Non riesco a salvare il progetto.');
    }
}

function openProjectFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const payload = JSON.parse(reader.result);
            if (payload.type && payload.type !== PROJECT_TYPE) {
                throw new Error('File non riconosciuto come progetto Carousel Maker');
            }
            if (!payload.json) throw new Error('Canvas mancante nel file');
            await applyProjectPayload(payload, { resetHistory: true });
            showToast('Progetto aperto');
        } catch (err) {
            console.warn('Apertura progetto fallita', err);
            alert('File progetto non valido. Usa un file .CMF (o .json) di Carousel Maker.');
        }
    };
    reader.onerror = () => alert('Lettura file fallita.');
    reader.readAsText(file);
}

document.getElementById('project-open').addEventListener('change', function(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) openProjectFile(file);
});

// --- PWA ---
function updateOnlineStatus() {
    const badge = document.getElementById('offline-badge');
    if (navigator.onLine) badge.classList.remove('show');
    else badge.classList.add('show');
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!localStorage.getItem('carousel-install-dismissed')) {
        document.getElementById('install-banner').classList.add('show');
    }
});

document.getElementById('btn-install').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('install-banner').classList.remove('show');
});

document.getElementById('btn-dismiss-install').addEventListener('click', () => {
    document.getElementById('install-banner').classList.remove('show');
    localStorage.setItem('carousel-install-dismissed', '1');
});

window.addEventListener('appinstalled', () => {
    document.getElementById('install-banner').classList.remove('show');
    deferredInstallPrompt = null;
});

// --- BOOT ---
function showToast(message, isError) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden', 'bg-gray-900', 'bg-red-600', 'bg-emerald-600');
    toast.classList.add(isError ? 'bg-red-600' : 'bg-emerald-600');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function updateAuthUI() {
    const guest = document.getElementById('auth-guest');
    const userBox = document.getElementById('auth-user');
    const emailEl = document.getElementById('user-email');
    if (currentUser) {
        guest.classList.add('hidden');
        userBox.classList.remove('hidden');
        emailEl.textContent = currentUser.email || '';
    } else {
        guest.classList.remove('hidden');
        userBox.classList.add('hidden');
        emailEl.textContent = '';
        currentProjectId = null;
        currentProjectName = null;
        updateCurrentProjectLabel();
    }
    void refreshAdminFlag();
}

function updateCurrentProjectLabel() {
    const label = document.getElementById('current-project-label');
    if (!label) return;
    label.textContent = currentProjectName
        ? `Aperto: ${currentProjectName}`
        : 'Nessun progetto aperto';
}

function openAuthModal(mode) {
    if (!supabaseClient) {
        showToast('Supabase non configurato. Imposta le env vars su Vercel e ridistribuisci.', true);
        return;
    }
    authMode = mode || 'login';
    switchAuthTab(authMode);
    document.getElementById('auth-error').classList.add('hidden');
    document.getElementById('auth-success').classList.add('hidden');
    document.getElementById('auth-form').reset();
    const modal = document.getElementById('auth-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function switchAuthTab(mode) {
    authMode = mode;
    const loginTab = document.getElementById('tab-login');
    const signupTab = document.getElementById('tab-signup');
    const nameField = document.getElementById('signup-name-field');
    const submitBtn = document.getElementById('auth-submit');
    document.getElementById('auth-error').classList.add('hidden');
    document.getElementById('auth-success').classList.add('hidden');

    if (mode === 'signup') {
        loginTab.classList.remove('auth-tab-active');
        signupTab.classList.add('auth-tab-active');
        nameField.classList.remove('hidden');
        submitBtn.textContent = 'Crea account';
    } else {
        signupTab.classList.remove('auth-tab-active');
        loginTab.classList.add('auth-tab-active');
        nameField.classList.add('hidden');
        submitBtn.textContent = 'Accedi';
    }
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-name').value.trim();
    const errEl = document.getElementById('auth-error');
    const okEl = document.getElementById('auth-success');
    const submitBtn = document.getElementById('auth-submit');
    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-60');

    try {
        const sb = requireSupabase();
        if (authMode === 'signup') {
            const { data, error } = await sb.auth.signUp({
                email,
                password,
                options: { data: { display_name: name || undefined } }
            });
            if (error) throw error;
            if (data.session) {
                currentUser = data.session.user;
                updateAuthUI();
                closeAuthModal();
                showToast('Account creato! Sei connesso.');
            } else {
                okEl.textContent = 'Controlla la tua email per confermare la registrazione, poi accedi.';
                okEl.classList.remove('hidden');
                switchAuthTab('login');
            }
        } else {
            const { data, error } = await sb.auth.signInWithPassword({ email, password });
            if (error) throw error;
            currentUser = data.user;
            updateAuthUI();
            closeAuthModal();
            showToast('Accesso effettuato!');
        }
    } catch (err) {
        errEl.textContent = err.message || 'Errore di autenticazione';
        errEl.classList.remove('hidden');
    } finally {
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-60');
    }
}

async function logout() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    isAdmin = false;
    updateAuthUI();
    showToast('Sei uscito dall\'account');
}

const LIBRARY_BUCKET = 'library';
const LIBRARY_MAX_BYTES = 6 * 1024 * 1024;
const LIBRARY_CATEGORIES = [
    { id: 'all', label: 'Tutti' },
    { id: 'divisori', label: 'Divisori' },
    { id: 'cornici', label: 'Cornici' },
    { id: 'sticker', label: 'Sticker' },
    { id: 'forme', label: 'Forme' },
    { id: 'altro', label: 'Altro' }
];

function isLibraryCategory(value) {
    return LIBRARY_CATEGORIES.some(c => c.id === value && c.id !== 'all');
}

function assetNameFromFile(file) {
    const raw = String(file && file.name || 'Asset').replace(/\.[^.]+$/, '');
    return raw.trim().slice(0, 80) || 'Asset';
}

function isAllowedLibraryFile(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '').toLowerCase();
    if (type === 'image/png' || type === 'image/webp') return true;
    return name.endsWith('.png') || name.endsWith('.webp');
}

function libraryObjectUrl(path) {
    const { data } = requireSupabase().storage.from(LIBRARY_BUCKET).getPublicUrl(path);
    return data.publicUrl;
}

function updateAdminOnlyUI() {
    document.querySelectorAll('[data-admin-only]').forEach(el => {
        el.classList.toggle('hidden', !isAdmin);
        if (el.id === 'library-admin' || el.id === 'btn-admin-library') {
            el.classList.toggle('flex', false);
        }
    });
    const adminBar = document.getElementById('library-admin');
    if (adminBar) adminBar.classList.toggle('hidden', !isAdmin);
    const adminBtn = document.getElementById('btn-admin-library');
    if (adminBtn) {
        if (isAdmin && currentUser) adminBtn.classList.remove('hidden');
        else adminBtn.classList.add('hidden');
    }
    if (libraryLoaded) renderLibraryGrid();
}

async function refreshAdminFlag() {
    isAdmin = false;
    if (currentUser && supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('profiles')
                .select('is_admin')
                .eq('id', currentUser.id)
                .maybeSingle();
            if (!error) isAdmin = !!(data && data.is_admin);
        } catch (err) {
            console.warn('Lettura ruolo admin fallita', err);
        }
    }
    updateAdminOnlyUI();
}

function renderLibraryCategories() {
    const wrap = document.getElementById('library-cats');
    if (!wrap) return;
    wrap.innerHTML = LIBRARY_CATEGORIES.map(cat => (
        `<button type="button" class="library-cat${libraryCategory === cat.id ? ' is-active' : ''}" data-cat="${cat.id}">${cat.label}</button>`
    )).join('');
    wrap.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            libraryCategory = btn.dataset.cat;
            renderLibraryCategories();
            renderLibraryGrid();
        });
    });
}

function renderLibraryGrid() {
    const grid = document.getElementById('library-grid');
    if (!grid) return;
    const items = libraryCategory === 'all'
        ? libraryAssets
        : libraryAssets.filter(a => a.category === libraryCategory);

    if (!items.length) {
        grid.innerHTML = `<p class="col-span-full text-sm text-gray-400 text-center py-8">${
            libraryLoaded
                ? (isAdmin ? 'Nessun PNG in questa categoria. Caricane uno sopra.' : 'La libreria è vuota. Torna più tardi.')
                : 'Caricamento…'
        }</p>`;
        return;
    }

    grid.innerHTML = items.map(asset => {
        const url = libraryObjectUrl(asset.storage_path);
        const del = isAdmin
            ? `<button type="button" class="absolute top-1 right-1 w-7 h-7 rounded-full bg-white/90 text-red-500 text-sm font-bold shadow" data-del="${asset.id}" aria-label="Elimina">✕</button>`
            : '';
        return `<button type="button" class="asset-card relative rounded-xl overflow-hidden border border-gray-200 text-left" data-add="${asset.id}">
            <span class="asset-thumb block aspect-square">
                <img src="${escapeHtml(url)}" alt="" class="w-full h-full object-contain">
            </span>
            <span class="block px-1.5 py-1 text-[10px] font-semibold text-gray-600 truncate">${escapeHtml(asset.name)}</span>
            ${del}
        </button>`;
    }).join('');

    grid.querySelectorAll('[data-add]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (e.target.closest('[data-del]')) return;
            addLibraryAssetToCanvas(btn.dataset.add);
        });
    });
    grid.querySelectorAll('[data-del]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteLibraryAsset(btn.dataset.del);
        });
    });
}

async function refreshLibraryAssets() {
    const grid = document.getElementById('library-grid');
    if (!supabaseClient) {
        libraryAssets = [];
        libraryLoaded = true;
        if (grid) grid.innerHTML = '<p class="col-span-full text-sm text-gray-400 text-center py-8">Supabase non configurato.</p>';
        return;
    }
    try {
        const { data, error } = await supabaseClient
            .from('library_assets')
            .select('id, name, category, storage_path, created_at')
            .order('created_at', { ascending: false });
        if (error) throw error;
        libraryAssets = data || [];
        libraryLoaded = true;
        renderLibraryGrid();
    } catch (err) {
        console.warn('Libreria non disponibile', err);
        libraryLoaded = true;
        if (grid) {
            grid.innerHTML = '<p class="col-span-full text-sm text-red-500 text-center py-8">Impossibile caricare la libreria. Esegui la migration SQL.</p>';
        }
    }
}

async function openLibraryModal(opts) {
    if (!supabaseClient) {
        showToast('Supabase non configurato. Imposta le env vars su Vercel.', true);
        return;
    }
    if (opts && opts.admin && !isAdmin) {
        showToast('Accesso admin richiesto', true);
        return;
    }
    const modal = document.getElementById('library-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    renderLibraryCategories();
    updateAdminOnlyUI();
    await refreshLibraryAssets();
}

function closeLibraryModal() {
    const modal = document.getElementById('library-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function addLibraryAssetToCanvas(id, { keepOpen = false } = {}) {
    const asset = libraryAssets.find(a => a.id === id);
    if (!asset) return;
    if (pageEditorMode) setPageEditorMode(false);
    const url = libraryObjectUrl(asset.storage_path);
    const hint = document.getElementById('hint-toast');
    if (hint) hint.textContent = 'Inserimento grafica…';
    try {
        await new Promise((resolve, reject) => {
            fabric.Image.fromURL(url, function(img) {
                try {
                    if (!img || typeof img.width !== 'number') {
                        reject(new Error('Immagine non decodificata'));
                        return;
                    }
                    placeFabricImageOnCurrentPage(img);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, { crossOrigin: 'anonymous' });
        });
        if (!keepOpen) closeLibraryModal();
        showToast('Grafica aggiunta alla pagina');
        updateMobileHint();
    } catch (err) {
        console.warn(err);
        showToast('Non riesco a inserire questo PNG', true);
        updateMobileHint();
    }
}

async function uploadLibraryFiles(fileList) {
    if (!isAdmin) {
        showToast('Solo l\'admin può caricare nella libreria. Accedi con l\'account admin.', true);
        return;
    }
    const categoryEl = document.getElementById('library-upload-category');
    const category = categoryEl ? categoryEl.value : '';
    if (!isLibraryCategory(category)) {
        showToast('Categoria non valida', true);
        return;
    }
    const files = Array.from(fileList || []);
    if (!files.length) {
        showToast('Nessun file selezionato', true);
        return;
    }

    showToast('Caricamento in libreria…');
    let ok = 0;
    let lastId = null;
    try {
        const sb = requireSupabase();
        for (const file of files) {
            if (!isAllowedLibraryFile(file)) {
                showToast(`${file.name}: usa un PNG o WebP (non JPEG/HEIC)`, true);
                continue;
            }
            if (file.size > LIBRARY_MAX_BYTES) {
                showToast(`${file.name}: max 6 MB`, true);
                continue;
            }
            const ext = String(file.name || '').toLowerCase().endsWith('.webp') || file.type === 'image/webp' ? 'webp' : 'png';
            const id = (window.crypto && crypto.randomUUID)
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const path = `${category}/${id}.${ext}`;
            const { error: upErr } = await sb.storage.from(LIBRARY_BUCKET).upload(path, file, {
                contentType: ext === 'webp' ? 'image/webp' : 'image/png',
                upsert: false,
                cacheControl: '3600'
            });
            if (upErr) {
                const hint = /bucket|not found|does not exist/i.test(upErr.message || '')
                    ? ' Esegui la migration SQL 004_library_assets.sql su Supabase.'
                    : '';
                showToast((upErr.message || `Upload fallito: ${file.name}`) + hint, true);
                continue;
            }
            const { data: row, error: rowErr } = await sb.from('library_assets').insert({
                name: assetNameFromFile(file),
                category,
                storage_path: path,
                created_by: currentUser && currentUser.id
            }).select('id').single();
            if (rowErr) {
                await sb.storage.from(LIBRARY_BUCKET).remove([path]);
                const hint = /schema cache|does not exist|relation/i.test(rowErr.message || '')
                    ? ' Esegui la migration SQL 004_library_assets.sql su Supabase.'
                    : '';
                showToast((rowErr.message || 'Salvataggio catalogo fallito') + hint, true);
                continue;
            }
            ok += 1;
            lastId = row && row.id;
            if (lastId && !libraryAssets.some(a => a.id === lastId)) {
                libraryAssets.unshift({
                    id: lastId,
                    name: assetNameFromFile(file),
                    category,
                    storage_path: path,
                    created_at: new Date().toISOString()
                });
            }
        }
    } catch (err) {
        showToast(err.message || 'Upload libreria fallito', true);
        return;
    }

    if (!ok) return;
    await refreshLibraryAssets();
    if (lastId) {
        await addLibraryAssetToCanvas(lastId);
        showToast(ok === 1
            ? 'Salvato in Grafica e inserito nella pagina'
            : `${ok} PNG in libreria; l’ultimo è sulla pagina`);
    } else {
        showToast(ok === 1 ? 'PNG salvato in Grafica' : `${ok} PNG salvati in Grafica`);
    }
}

async function deleteLibraryAsset(id) {
    if (!isAdmin) return;
    const asset = libraryAssets.find(a => a.id === id);
    if (!asset) return;
    if (!confirm(`Eliminare “${asset.name}” dalla libreria?`)) return;
    try {
        const sb = requireSupabase();
        const { error: rowErr } = await sb.from('library_assets').delete().eq('id', id);
        if (rowErr) throw rowErr;
        await sb.storage.from(LIBRARY_BUCKET).remove([asset.storage_path]);
        showToast('Rimosso dalla libreria');
        await refreshLibraryAssets();
    } catch (err) {
        showToast(err.message || 'Eliminazione fallita', true);
    }
}

document.getElementById('library-upload').addEventListener('change', async function(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await uploadLibraryFiles(files);
});
document.getElementById('library-modal').addEventListener('click', function(e) {
    if (e.target === this) closeLibraryModal();
});



const CLOUD_PROJECT_LIMIT = 3;

async function projectRowFromLocal(name) {
    const payload = buildProjectPayload();
    const canvas_data = { ...(payload.json || {}) };
    try {
        const hiRes = await collectHiResDataUrls();
        if (hiRes && Object.keys(hiRes).length) {
            canvas_data._carouselHiRes = hiRes;
        }
    } catch (err) {
        console.warn('Allegato hi-res cloud non disponibile', err);
    }
    return {
        name,
        canvas_data,
        square_count: payload.squareCount,
        background_color: payload.backgroundColor || '#ffffff',
        aspect_ratio: payload.aspectRatio || '1:1',
    };
}

function localPayloadFromRow(row) {
    const extracted = stripEmbeddedHiRes(row.canvas_data);
    return {
        type: PROJECT_TYPE,
        version: PROJECT_VERSION,
        squareCount: row.square_count || 1,
        aspectRatio: row.aspect_ratio || '1:1',
        backgroundColor: row.background_color || '#ffffff',
        json: extracted.json,
        hiRes: extracted.hiRes,
        savedAt: Date.now(),
    };
}

async function countCloudProjects() {
    const { count, error } = await requireSupabase()
        .from('projects')
        .select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
}

function updateCloudSlotsUI(count) {
    const label = document.getElementById('cloud-slots-label');
    const hint = document.getElementById('cloud-limit-hint');
    const saveBtn = document.getElementById('btn-save-new-cloud');
    const nameInput = document.getElementById('new-project-name');
    const atLimit = count >= CLOUD_PROJECT_LIMIT;

    if (label) {
        label.textContent = `${count} / ${CLOUD_PROJECT_LIMIT}`;
        label.classList.toggle('text-amber-700', atLimit);
        label.classList.toggle('text-gray-500', !atLimit);
    }
    if (hint) hint.classList.toggle('hidden', !atLimit);
    if (saveBtn) saveBtn.disabled = atLimit;
    if (nameInput) nameInput.disabled = atLimit;
}

async function saveCurrentProject() {
    if (!supabaseClient) {
        showToast('Supabase non configurato. Imposta le env vars su Vercel.', true);
        return;
    }
    if (!currentUser) {
        openAuthModal('login');
        showToast('Accedi per salvare i progetti nel cloud', true);
        return;
    }
    if (!currentProjectId) {
        try {
            const count = await countCloudProjects();
            if (count >= CLOUD_PROJECT_LIMIT) {
                showToast(`Limite ${CLOUD_PROJECT_LIMIT} progetti cloud. Salva in locale (.CMF).`, true);
                openProjectsModal();
                return;
            }
        } catch (_) { /* open modal anyway */ }
        openProjectsModal();
        document.getElementById('new-project-name')?.focus();
        showToast('Scegli un nome e salva come nuovo progetto');
        return;
    }

    const btn = document.getElementById('btn-cloud-save');
    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const { name, ...row } = await projectRowFromLocal(currentProjectName || 'Senza nome');
        const { error } = await requireSupabase()
            .from('projects')
            .update(row)
            .eq('id', currentProjectId);
        if (error) throw error;
        persistProject();
        showToast('Progetto salvato nel cloud!');
    } catch (err) {
        showToast(err.message || 'Errore nel salvataggio', true);
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-60'); }
    }
}

async function saveAsNewProject() {
    if (!supabaseClient) {
        showToast('Supabase non configurato. Imposta le env vars su Vercel.', true);
        return;
    }
    if (!currentUser) {
        openAuthModal('login');
        return;
    }
    const nameInput = document.getElementById('new-project-name');
    const name = nameInput.value.trim();
    const feedback = document.getElementById('projects-feedback');
    if (!name) {
        feedback.textContent = 'Inserisci un nome per il progetto.';
        feedback.className = 'mt-2 text-sm rounded-xl px-3 py-2 text-red-600 bg-red-50';
        feedback.classList.remove('hidden');
        return;
    }

    try {
        const count = await countCloudProjects();
        if (count >= CLOUD_PROJECT_LIMIT) {
            updateCloudSlotsUI(count);
            feedback.textContent = `Limite di ${CLOUD_PROJECT_LIMIT} progetti cloud raggiunto. Eliminane uno oppure salva in locale (.CMF).`;
            feedback.className = 'mt-2 text-sm rounded-xl px-3 py-2 text-amber-800 bg-amber-50';
            feedback.classList.remove('hidden');
            showToast('Usa Salva file .CMF per altri progetti', true);
            return;
        }

        const row = {
            user_id: currentUser.id,
            ...(await projectRowFromLocal(name)),
            name,
        };
        const { data, error } = await requireSupabase()
            .from('projects')
            .insert(row)
            .select('id, name')
            .single();
        if (error) throw error;
        currentProjectId = data.id;
        currentProjectName = data.name;
        updateCurrentProjectLabel();
        nameInput.value = '';
        feedback.textContent = 'Progetto creato e salvato nel cloud!';
        feedback.className = 'mt-2 text-sm rounded-xl px-3 py-2 text-emerald-700 bg-emerald-50';
        feedback.classList.remove('hidden');
        persistProject();
        showToast('Nuovo progetto salvato!');
        await refreshProjectsList();
    } catch (err) {
        feedback.textContent = err.message || 'Errore nel salvataggio';
        feedback.className = 'mt-2 text-sm rounded-xl px-3 py-2 text-red-600 bg-red-50';
        feedback.classList.remove('hidden');
    }
}

async function openProjectsModal() {
    if (!supabaseClient) {
        showToast('Supabase non configurato. Imposta le env vars su Vercel.', true);
        return;
    }
    if (!currentUser) {
        openAuthModal('login');
        return;
    }
    document.getElementById('projects-feedback').classList.add('hidden');
    updateCurrentProjectLabel();
    const modal = document.getElementById('projects-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    await refreshProjectsList();
}

function closeProjectsModal() {
    const modal = document.getElementById('projects-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function formatDate(iso) {
    try {
        return new Date(iso).toLocaleString('it-IT', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (_) {
        return '';
    }
}

async function refreshProjectsList() {
    const list = document.getElementById('projects-list');
    list.innerHTML = '<p class="text-sm text-gray-400 text-center py-8">Caricamento…</p>';
    try {
        const { data, error } = await requireSupabase()
            .from('projects')
            .select('id, name, square_count, aspect_ratio, updated_at')
            .order('updated_at', { ascending: false });
        if (error) throw error;

        const count = data ? data.length : 0;
        updateCloudSlotsUI(count);

        if (!data || data.length === 0) {
            list.innerHTML = '<p class="text-sm text-gray-400 text-center py-8">Nessun progetto cloud. Puoi salvarne fino a 3, oppure usa file .CMF in locale.</p>';
            return;
        }

        list.innerHTML = data.map(p => {
            const active = p.id === currentProjectId;
            return `
                <div class="flex items-center gap-3 p-3 rounded-xl border ${active ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white'} transition">
                    <div class="flex-1 min-w-0">
                        <p class="font-semibold text-sm text-gray-800 truncate">${escapeHtml(p.name)}</p>
                        <p class="text-xs text-gray-500">${p.square_count} slide · ${escapeHtml(p.aspect_ratio || '1:1')} · ${formatDate(p.updated_at)}</p>
                    </div>
                    <button onclick="loadCloudProject('${p.id}')" class="text-xs font-semibold px-3 py-1.5 rounded-full bg-gray-100 text-gray-700">Apri</button>
                    <button onclick="renameCloudProject('${p.id}', '${escapeAttr(p.name)}')" class="text-xs font-semibold px-2 py-1.5 rounded-full text-gray-500" title="Rinomina">✏️</button>
                    <button onclick="deleteCloudProject('${p.id}')" class="text-xs font-semibold px-2 py-1.5 rounded-full text-red-500" title="Elimina">🗑️</button>
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = `<p class="text-sm text-red-500 text-center py-8">${escapeHtml(err.message || 'Errore nel caricamento')}</p>`;
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function loadCloudProject(id) {
    try {
        const { data, error } = await requireSupabase()
            .from('projects')
            .select('*')
            .eq('id', id)
            .single();
        if (error) throw error;
        currentProjectId = data.id;
        currentProjectName = data.name;
        updateCurrentProjectLabel();
        await applyProjectPayload(localPayloadFromRow(data), { resetHistory: true });
        closeProjectsModal();
        showToast(`Aperto: ${data.name}`);
    } catch (err) {
        showToast(err.message || 'Impossibile aprire il progetto', true);
    }
}

async function renameCloudProject(id, oldName) {
    const name = prompt('Nuovo nome del progetto:', oldName);
    if (!name || !name.trim() || name.trim() === oldName) return;
    try {
        const { error } = await requireSupabase()
            .from('projects')
            .update({ name: name.trim() })
            .eq('id', id);
        if (error) throw error;
        if (currentProjectId === id) {
            currentProjectName = name.trim();
            updateCurrentProjectLabel();
        }
        await refreshProjectsList();
        showToast('Progetto rinominato');
    } catch (err) {
        showToast(err.message || 'Errore nel rinominare', true);
    }
}

async function deleteCloudProject(id) {
    if (!confirm('Eliminare definitivamente questo progetto dal cloud?')) return;
    try {
        const { error } = await requireSupabase()
            .from('projects')
            .delete()
            .eq('id', id);
        if (error) throw error;
        if (currentProjectId === id) {
            currentProjectId = null;
            currentProjectName = null;
            updateCurrentProjectLabel();
        }
        await refreshProjectsList();
        showToast('Progetto eliminato');
    } catch (err) {
        showToast(err.message || "Errore nell'eliminazione", true);
    }
}

document.getElementById('auth-modal').addEventListener('click', function(e) {
    if (e.target === this) closeAuthModal();
});
document.getElementById('projects-modal').addEventListener('click', function(e) {
    if (e.target === this) closeProjectsModal();
});

async function initAuth() {
    if (!supabaseClient) {
        updateAuthUI();
        return;
    }
    const { data: { session } } = await supabaseClient.auth.getSession();
    currentUser = session ? session.user : null;
    updateAuthUI();
    await refreshAdminFlag();
    supabaseClient.auth.onAuthStateChange((_event, session) => {
        currentUser = session ? session.user : null;
        updateAuthUI();
    });
}


Object.assign(window, {
  undo,
  redo,
  zoomIn,
  zoomOut,
  fitToScreen,
  deleteSelected,
  deleteCurrentPage,
  exportCarousel,
  saveProjectFile,
  addSquare,
  startCrop,
  applyCrop,
  cancelCrop,
  changeLayer,
  toggleRuleGrid,
  toggleSnap,
  togglePageEditorMode,
  setPageEditorMode,
  openAuthModal,
  closeAuthModal,
  switchAuthTab,
  handleAuthSubmit,
  logout,
  openProjectsModal,
  closeProjectsModal,
  saveCurrentProject,
  saveAsNewProject,
  loadCloudProject,
  renameCloudProject,
  deleteCloudProject,
  openLibraryModal,
  closeLibraryModal,
});

(async function boot() {
    await initAuth();
    updateMobileHint();
    applyInteractionMode();
    updateAspectToggleUI();
    document.querySelectorAll('#aspect-toggle .aspect-btn').forEach(btn => {
        btn.addEventListener('click', () => setAspectRatio(btn.dataset.aspect));
    });
    renderPagesUI();

    let restored = false;
    try {
        restored = await restoreProject();
    } catch (err) {
        console.warn(err);
        restored = false;
    }

    if (!restored) {
        // Stato pulito se l'autosave era corrotto / incompleto
        squareCount = 1;
        aspectRatio = '1:1';
        pageW = ASPECT_PRESETS['1:1'].w;
        pageH = ASPECT_PRESETS['1:1'].h;
        updateAspectToggleUI();
        syncCanvasSize();
        initHistory();
    }

    applyInteractionMode();
    configureAllObjectControls();
    renderPagesUI();
    // Layout flex a volte è pronto solo al frame successivo: centra due volte.
    fitToScreen();
    requestAnimationFrame(() => {
        fitToScreen();
        requestAnimationFrame(() => fitToScreen());
    });
})();
    