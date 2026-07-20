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
const STORAGE_KEY = 'carousel-maker-project-v4';
const PROJECT_TYPE = 'carousel-maker-project';
const PROJECT_VERSION = 1;
const FABRIC_JSON_PROPS = ['isGuideLine', 'selectable', 'evented', 'isAlignmentLine', 'isCropRect'];
const LONG_PRESS_MS = 1000;
const LONG_PRESS_MOVE_TOL = 12;
const LONG_PRESS_RING_DELAY = 380;
const FIT_SCALE = 0.86; // pagine un filo più piccole del fit pieno

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

let deferredInstallPrompt = null;
let currentVisiblePage = 0;

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

function updateMobileHint() {
    const hint = document.getElementById('hint-toast');
    if (!hint) return;
    if (isMobileUI()) {
        hint.innerHTML = 'Trascina lo <strong>sfondo</strong> per spostare la vista · Tieni 1s per riordinare · Pinch sull’immagine';
    } else {
        hint.innerHTML = 'Trascina sullo <strong>sfondo</strong> per selezione multipla · Tieni 1s per spostare una pagina';
    }
}

function applyInteractionMode() {
    // Marquee / selezione multipla solo su PC; su mobile il drag sullo sfondo fa pan
    canvas.selection = !isMobileUI();
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
    backgroundColor: '#ffffff',
    preserveObjectStacking: true,
    uniformScaling: false,
    uniScaleKey: 'shiftKey',
    allowTouchScrolling: true,
    selection: true
});

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
        canvas.setWidth(pageW * squareCount);
        canvas.setHeight(pageH);
        document.getElementById('canvas-wrapper').style.width = (pageW * squareCount) + 'px';
        document.getElementById('canvas-wrapper').style.height = pageH + 'px';
        guideLines = canvas.getObjects().filter(o => o.isGuideLine);
        canvas.renderAll();
        isHistoryAction = false;
        updateUndoRedoUI();
        configureAllObjectControls();
        updateToolbarPosition();
        renderPagesUI();
        applyZoom();
        persistProject();
    });
}

canvas.on('object:modified', saveState);
canvas.on('object:added', (e) => {
    if (!isHistoryAction && !e.target.isGuideLine && !e.target.isCropRect && !e.target.isAlignmentLine) saveState();
});
canvas.on('object:removed', (e) => {
    if (!isHistoryAction && !e.target.isGuideLine && !e.target.isCropRect && !e.target.isAlignmentLine) saveState();
});

// --- SMART GUIDES ---
let currentSnapLines = [];
let pendingSnapMove = null;
let pendingSnapScale = null;
const SNAP_DISTANCE = 10;

function clearGuidelines() {
    if (currentSnapLines.length > 0 || pendingSnapMove || pendingSnapScale) {
        currentSnapLines = [];
        pendingSnapMove = null;
        pendingSnapScale = null;
        canvas.renderAll();
    }
}

function handleSnapping(e) {
    if (pageDrag.active || pageDrag.armed || viewPan.active) return;
    const obj = e.target;
    if (!obj || obj.isCropping) return;
    if (e.e && e.e.altKey) { clearGuidelines(); return; }

    const action = e.transform ? e.transform.action : '';
    const isMoving = action === 'drag';
    const isScaling = action.includes('scale');
    if (!isMoving && !isScaling) { clearGuidelines(); return; }

    const objBounds = obj.getBoundingRect();
    const objCenter = obj.getCenterPoint();
    const targets = [];
    canvas.getObjects().forEach(t => {
        if (t === obj || t.isGuideLine || t.isCropRect || t.isAlignmentLine) return;
        const bounds = t.getBoundingRect();
        const center = t.getCenterPoint();
        targets.push({
            left: bounds.left, centerX: center.x, right: bounds.left + bounds.width,
            top: bounds.top, centerY: center.y, bottom: bounds.top + bounds.height
        });
    });
    if (!targets.length) return;

    let linesToDraw = [];

    if (isMoving) {
        let snapX = null, snapY = null;
        let diffX = SNAP_DISTANCE + 1, diffY = SNAP_DISTANCE + 1;
        let finalLeft = obj.left, finalTop = obj.top;

        targets.forEach(t => {
            const objXs = [
                { val: objBounds.left, type: 'left' },
                { val: objCenter.x, type: 'center' },
                { val: objBounds.left + objBounds.width, type: 'right' }
            ];
            [t.left, t.centerX, t.right].forEach(tx => {
                objXs.forEach(ox => {
                    if (Math.abs(ox.val - tx) < diffX) {
                        diffX = Math.abs(ox.val - tx);
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
            [t.top, t.centerY, t.bottom].forEach(ty => {
                objYs.forEach(oy => {
                    if (Math.abs(oy.val - ty) < diffY) {
                        diffY = Math.abs(oy.val - ty);
                        snapY = ty;
                        if (oy.type === 'top') finalTop = obj.top + (ty - objBounds.top);
                        if (oy.type === 'center') finalTop = obj.top + (ty - objCenter.y);
                        if (oy.type === 'bottom') finalTop = obj.top + (ty - (objBounds.top + objBounds.height));
                    }
                });
            });
        });

        if (snapX !== null) linesToDraw.push([snapX, -10000, snapX, 10000]);
        if (snapY !== null) linesToDraw.push([-10000, snapY, 10000, snapY]);
        pendingSnapMove = (snapX !== null || snapY !== null) ? { left: finalLeft, top: finalTop } : null;
    }

    if (isScaling) {
        let activeCorner = e.transform.corner;
        let scaleSnapX = null, scaleSnapY = null;
        let sDiffX = SNAP_DISTANCE + 1, sDiffY = SNAP_DISTANCE + 1;

        targets.forEach(t => {
            const targetXs = [t.left, t.centerX, t.right];
            const targetYs = [t.top, t.centerY, t.bottom];
            if (activeCorner.includes('l')) targetXs.forEach(tx => { if (Math.abs(objBounds.left - tx) < sDiffX) { sDiffX = Math.abs(objBounds.left - tx); scaleSnapX = tx; } });
            else if (activeCorner.includes('r')) targetXs.forEach(tx => { if (Math.abs((objBounds.left + objBounds.width) - tx) < sDiffX) { sDiffX = Math.abs((objBounds.left + objBounds.width) - tx); scaleSnapX = tx; } });
            if (activeCorner.includes('t')) targetYs.forEach(ty => { if (Math.abs(objBounds.top - ty) < sDiffY) { sDiffY = Math.abs(objBounds.top - ty); scaleSnapY = ty; } });
            else if (activeCorner.includes('b')) targetYs.forEach(ty => { if (Math.abs((objBounds.top + objBounds.height) - ty) < sDiffY) { sDiffY = Math.abs((objBounds.top + objBounds.height) - ty); scaleSnapY = ty; } });
        });

        if (scaleSnapX !== null) linesToDraw.push([scaleSnapX, -10000, scaleSnapX, 10000]);
        if (scaleSnapY !== null) linesToDraw.push([-10000, scaleSnapY, 10000, scaleSnapY]);

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
function applyZoom() {
    const wrapper = document.getElementById('canvas-wrapper');
    wrapper.style.transform = `scale(${currentZoom})`;
    document.getElementById('zoom-level').innerText = Math.round(currentZoom * 100) + '%';
    wrapper.style.width = (pageW * squareCount) + 'px';
    wrapper.style.height = pageH + 'px';
    centerStagePadding();
}

function centerStagePadding() {
    const workspace = document.getElementById('workspace');
    const stage = document.getElementById('canvas-stage');
    const scaledW = pageW * currentZoom;
    const scaledH = pageH * currentZoom;
    const totalW = scaledW * squareCount;
    const padX = Math.max(16, (workspace.clientWidth - scaledW) / 2);
    const padY = Math.max(16, (workspace.clientHeight - scaledH) / 2);
    stage.style.paddingLeft = padX + 'px';
    stage.style.paddingRight = padX + 'px';
    stage.style.paddingTop = padY + 'px';
    stage.style.paddingBottom = padY + 'px';
    stage.style.width = (totalW + padX * 2) + 'px';
    stage.style.minHeight = (scaledH + padY * 2) + 'px';
    const wrapper = document.getElementById('canvas-wrapper');
    const layoutW = pageW * squareCount;
    const layoutH = pageH;
    wrapper.style.marginRight = (totalW - layoutW) + 'px';
    wrapper.style.marginBottom = (scaledH - layoutH) + 'px';
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
    centerStagePadding();
    updateMobileHint();
    applyInteractionMode();
    configureAllObjectControls();
});

// --- TOOLBAR FLUTTUANTE ---
function updateToolbarPosition() {
    const activeObj = canvas.getActiveObject();
    const toolbar = document.getElementById('floating-toolbar');
    if (!activeObj || activeObj.isAlignmentLine || pageDrag.active) {
        toolbar.style.display = 'none';
        return;
    }
    toolbar.style.display = 'flex';
    const boundingRect = activeObj.getBoundingRect();
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
    canvas.setWidth(pageW * squareCount);
    canvas.setHeight(pageH);
    document.getElementById('canvas-wrapper').style.width = (pageW * squareCount) + 'px';
    document.getElementById('canvas-wrapper').style.height = pageH + 'px';
    rebuildGuideLines();
    applyZoom();
    renderPagesUI();
    renderRuleGrid();
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
    const target = padX + index * pageW * currentZoom - (workspace.clientWidth - pageW * currentZoom) / 2;
    workspace.scrollTo({
        left: Math.max(0, target),
        behavior: smooth ? 'smooth' : 'auto'
    });
    renderPagesUI();
}

function updateVisiblePageFromScroll() {
    const workspace = document.getElementById('workspace');
    const stage = document.getElementById('canvas-stage');
    const padX = parseFloat(stage.style.paddingLeft) || 0;
    const centerX = workspace.scrollLeft + workspace.clientWidth / 2 - padX;
    const page = Math.round(centerX / (pageW * currentZoom) - 0.5);
    const clamped = Math.max(0, Math.min(squareCount - 1, page));
    if (clamped !== currentVisiblePage) {
        currentVisiblePage = clamped;
        renderPagesUI();
    }
}

document.getElementById('workspace').addEventListener('scroll', () => {
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
        left: pageIndex * pageW,
        top: 0,
        width: pageW,
        height: pageH,
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
        o.selectable = true;
        o.evented = true;
    });
    canvas.selection = !isMobileUI();
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
    if (!isBackgroundTarget(opt.target)) return;

    const pt = clientPoint(opt.e);
    const workspace = document.getElementById('workspace');
    const pointer = canvas.getPointer(opt.e);
    const pageIndex = Math.max(0, Math.min(squareCount - 1, Math.floor(pointer.x / pageW)));

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

    if (squareCount >= 2) {
        pageDrag.armed = true;
        pageDrag.ringTimer = setTimeout(() => {
            if (pageDrag.armed && !viewPan.active) {
                showLongPressRing(pageDrag.startClientX, pageDrag.startClientY);
            }
        }, LONG_PRESS_RING_DELAY);
        pageDrag.timer = setTimeout(() => {
            if (viewPan.active) return;
            startPageDrag(pageIndex, pt.x, pt.y);
        }, LONG_PRESS_MS);
    }
});

canvas.on('mouse:move', function(opt) {
    const pt = clientPoint(opt.e);

    if (viewPan.active) {
        updateViewPan(pt);
        return;
    }

    if ((pageDrag.armed || viewPan.pending) && !pageDrag.active) {
        const startX = viewPan.pending ? viewPan.startClientX : pageDrag.startClientX;
        const startY = viewPan.pending ? viewPan.startClientY : pageDrag.startClientY;
        const dx = pt.x - startX;
        const dy = pt.y - startY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOL) {
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
    if (viewPan.active || viewPan.pending) {
        endViewPan();
    }
    if (pageDrag.armed && !pageDrag.active) {
        cancelLongPressArm();
        return;
    }
    if (pageDrag.active) finishPageDrag();
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
        x: (clientX - rect.left) / currentZoom,
        y: (clientY - rect.top) / currentZoom
    };
}

function beginPinchGesture(t1, t2) {
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
    if (pageDrag.armed || pageDrag.active || viewPan.active || viewPan.pending) {
        e.preventDefault();
    }
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
    cancelPageDrag();
}, { capture: true });

// --- BG / UPLOAD / DELETE ---
document.getElementById('bg-color').addEventListener('input', function(e) {
    const color = e.target.value;
    document.getElementById('bg-color-icon').style.backgroundColor = color;
    canvas.backgroundColor = color;
    canvas.renderAll();
});
document.getElementById('bg-color').addEventListener('change', saveState);

function addSquare() {
    squareCount++;
    syncCanvasSize();
    canvas.renderAll();
    saveState();
    scrollToPage(squareCount - 1, true);
}

document.getElementById('image-upload').addEventListener('change', async function(e) {
    const files = e.target.files;
    if (!files.length) return;
    if (typeof fabric === 'undefined' || !canvas) {
        alert('Editor non pronto. Ricarica la pagina.');
        return;
    }
    const baseLeft = currentVisiblePage * pageW;
    const fileList = Array.from(files);
    e.target.value = '';

    for (let i = 0; i < fileList.length; i++) {
        try {
            const dataURL = await readAndDownscaleImage(fileList[i], MAX_IMAGE_SHORT_SIDE);
            await new Promise((resolve, reject) => {
                fabric.Image.fromURL(dataURL, function(img) {
                    try {
                        if (!img || typeof img.width !== 'number') {
                            reject(new Error('Immagine non decodificata'));
                            return;
                        }
                        const maxDim = Math.max(img.width, img.height) || 1;
                        const fit = (Math.min(pageW, pageH) * 0.9) / maxDim;
                        if (fit < 1) img.scale(fit);

                        img.set({
                            left: baseLeft + (pageW / 2) - (img.getScaledWidth() / 2),
                            top: (pageH / 2) - (img.getScaledHeight() / 2)
                        });
                        canvas.add(img);
                        canvas.setActiveObject(img);
                        configureObjectControls(img);
                        canvas.requestRenderAll();
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
});

/** Legge un file e, se serve, ridimensiona il lato corto a maxShortSide (bitmap reale). */
function readAndDownscaleImage(file, maxShortSide) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.onload = () => {
            const src = reader.result;
            const img = new Image();
            img.onload = () => {
                const shortSide = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
                if (shortSide <= maxShortSide) {
                    resolve(src);
                    return;
                }
                const scale = maxShortSide / shortSide;
                const w = Math.max(1, Math.round(img.naturalWidth * scale));
                const h = Math.max(1, Math.round(img.naturalHeight * scale));
                const c = document.createElement('canvas');
                c.width = w;
                c.height = h;
                const ctx = c.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);
                // JPEG più leggero in memoria / localStorage (foto carousel)
                resolve(c.toDataURL('image/jpeg', 0.92));
            };
            img.onerror = () => reject(new Error('decode failed'));
            img.src = src;
        };
        reader.readAsDataURL(file);
    });
}

function deleteSelected() {
    if (isCropping || pageDrag.active) return;
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
        cancelPageDrag();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); changeLayer('up'); }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); changeLayer('down'); }
});

function exportCarousel() {
    guideLines.forEach(line => line.set('opacity', 0));
    canvas.discardActiveObject();
    canvas.renderAll();
    for (let i = 0; i < squareCount; i++) {
        const dataURL = canvas.toDataURL({
            format: 'jpeg', quality: 1,
            left: i * pageW, top: 0, width: pageW, height: pageH
        });
        const link = document.createElement('a');
        link.download = `carousel-slide-${i + 1}.jpg`;
        link.href = dataURL;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
    guideLines.forEach(line => line.set('opacity', 1));
    canvas.renderAll();
}

// --- PERSISTENZA & PROGETTO ---
function buildProjectPayload() {
    return {
        type: PROJECT_TYPE,
        version: PROJECT_VERSION,
        squareCount,
        aspectRatio,
        backgroundColor: canvas.backgroundColor,
        // Fabric serializza le immagini come data URL (base64): un solo file portatile
        json: canvas.toJSON(FABRIC_JSON_PROPS),
        savedAt: Date.now()
    };
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
            if (typeof endPinchGesture === 'function') endPinchGesture(false);

            canvas.loadFromJSON(payload.json, function() {
                try {
                    squareCount = payload.squareCount || 1;
                    aspectRatio = resolveAspectKey(payload.aspectRatio || '1:1');
                    pageW = ASPECT_PRESETS[aspectRatio].w;
                    pageH = ASPECT_PRESETS[aspectRatio].h;
                    updateAspectToggleUI();

                    if (payload.backgroundColor) {
                        canvas.backgroundColor = payload.backgroundColor;
                        document.getElementById('bg-color').value = payload.backgroundColor;
                        document.getElementById('bg-color-icon').style.backgroundColor = payload.backgroundColor;
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

function saveProjectFile() {
    if (isCropping || pageDrag.active) return;
    try {
        const payload = buildProjectPayload();
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const link = document.createElement('a');
        link.download = `carousel-progetto-${stamp}.json`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        } catch (err) {
            console.warn('Apertura progetto fallita', err);
            alert('File progetto non valido.');
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
    updateAuthUI();
    showToast('Sei uscito dall\'account');
}



function projectRowFromLocal(name) {
    const payload = buildProjectPayload();
    return {
        name,
        canvas_data: payload.json,
        square_count: payload.squareCount,
        background_color: payload.backgroundColor || '#ffffff',
        aspect_ratio: payload.aspectRatio || '1:1',
    };
}

function localPayloadFromRow(row) {
    return {
        type: PROJECT_TYPE,
        version: PROJECT_VERSION,
        squareCount: row.square_count || 1,
        aspectRatio: row.aspect_ratio || '1:1',
        backgroundColor: row.background_color || '#ffffff',
        json: row.canvas_data,
        savedAt: Date.now(),
    };
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
        openProjectsModal();
        document.getElementById('new-project-name')?.focus();
        showToast('Scegli un nome e salva come nuovo progetto');
        return;
    }

    const btn = document.getElementById('btn-cloud-save');
    if (btn) { btn.disabled = true; btn.classList.add('opacity-60'); }
    try {
        const { name, ...row } = projectRowFromLocal(currentProjectName || 'Senza nome');
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
        const row = {
            user_id: currentUser.id,
            ...projectRowFromLocal(name),
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

        if (!data || data.length === 0) {
            list.innerHTML = '<p class="text-sm text-gray-400 text-center py-8">Nessun progetto salvato ancora.</p>';
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

    // Sempre centratura/zoom, anche dopo restore async
    fitToScreen();
    applyInteractionMode();
    configureAllObjectControls();
    renderPagesUI();
})();
    