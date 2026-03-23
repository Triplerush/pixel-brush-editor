/**
 * PixelBrush — Selective Pixelation Editor
 * ──────────────────────────────────────────
 * Pure vanilla JS canvas-based image editor.
 * Uses a dual-canvas architecture:
 *   • Display canvas: scaled to fit the viewport (visual feedback)
 *   • Full-res canvas: offscreen, original resolution (pixelation + export)
 */

(() => {
    'use strict';

    // ═══════════════════════════════════════════
    // DOM References
    // ═══════════════════════════════════════════
    const $ = (sel) => document.querySelector(sel);

    const dom = {
        sidebar: $('#sidebar'),
        main: $('#main'),
        fileInput: $('#file-input'),
        btnUpload: $('#btn-upload'),
        btnUndo: $('#btn-undo'),
        btnReset: $('#btn-reset'),
        btnExport: $('#btn-export'),
        brushSize: $('#brush-size'),
        brushSizeVal: $('#brush-size-value'),
        brushSizeGroup: $('#brush-size-group'),
        pixelSize: $('#pixel-size'),
        pixelSizeVal: $('#pixel-size-value'),
        fileName: $('#file-name'),
        emptyState: $('#empty-state'),
        canvasWrapper: $('#canvas-wrapper'),
        displayCanvas: $('#display-canvas'),
        brushCursor: $('#brush-cursor'),
        selectionRect: $('#selection-rect'),
        toolBrush: $('#tool-brush'),
        toolZone: $('#tool-zone'),
        dropOverlay: $('#drop-overlay'),
        statusBar: $('#status-bar'),
        statusDims: $('#status-dimensions'),
        statusZoom: $('#status-zoom'),
        statusUndo: $('#status-undo-count'),
    };

    // ═══════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════
    const state = {
        originalImage: null,        // HTMLImageElement — pristine copy
        brushRadius: 30,            // display-space radius
        blockSize: 10,              // pixelation block size (full-res pixels)
        scaleFactor: 1,             // displaySize / originalSize
        isPainting: false,
        undoStack: [],              // Array<ImageData> on full-res canvas
        hasImage: false,
        lastPaintPos: null,         // { x, y } for stroke interpolation
        activeTool: 'brush',        // 'brush' | 'zone'
        isSelecting: false,         // zone tool: drag in progress
        selectionStart: null,       // { x, y } display-space start
        selectionEnd: null,         // { x, y } display-space end
    };

    // Offscreen full-resolution canvas
    const fullResCanvas = document.createElement('canvas');
    const fullResCtx = fullResCanvas.getContext('2d', { willReadFrequently: true });

    // Display canvas context
    const displayCtx = dom.displayCanvas.getContext('2d');

    // ═══════════════════════════════════════════
    // Image Loading
    // ═══════════════════════════════════════════

    /**
     * Load an image from a File object and initialize both canvases.
     * @param {File} file
     */
    function loadImageFile(file) {
        if (!file || !file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => initializeCanvases(img, file.name);
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    /**
     * Set up both canvases after loading an image.
     * @param {HTMLImageElement} img
     * @param {string} name
     */
    function initializeCanvases(img, name) {
        state.originalImage = img;
        state.undoStack = [];
        state.hasImage = true;

        // Full-res canvas at original dimensions
        fullResCanvas.width = img.naturalWidth;
        fullResCanvas.height = img.naturalHeight;
        fullResCtx.drawImage(img, 0, 0);

        // Compute display size to fit within the main area
        fitDisplayCanvas();

        // UI updates
        dom.fileName.textContent = name || 'Imagen cargada';
        dom.emptyState.classList.add('hidden');
        dom.canvasWrapper.classList.remove('hidden');
        dom.statusBar.classList.remove('hidden');
        dom.btnReset.disabled = false;
        dom.btnExport.disabled = false;
        updateUndoButton();
        updateStatusBar();
    }

    /**
     * Scale the display canvas to fit the viewport while maintaining aspect ratio.
     */
    function fitDisplayCanvas() {
        if (!state.originalImage) return;

        const mainRect = dom.main.getBoundingClientRect();
        const padding = 48; // px on each side
        const maxW = mainRect.width - padding * 2;
        const maxH = mainRect.height - padding * 2;
        const imgW = state.originalImage.naturalWidth;
        const imgH = state.originalImage.naturalHeight;

        const scale = Math.min(1, maxW / imgW, maxH / imgH);
        state.scaleFactor = scale;

        const displayW = Math.round(imgW * scale);
        const displayH = Math.round(imgH * scale);

        dom.displayCanvas.width = displayW;
        dom.displayCanvas.height = displayH;

        // Draw current full-res state onto display canvas
        syncDisplayCanvas();
    }

    /**
     * Copy from full-res canvas to display canvas (scaled down).
     */
    function syncDisplayCanvas() {
        displayCtx.clearRect(0, 0, dom.displayCanvas.width, dom.displayCanvas.height);
        displayCtx.drawImage(fullResCanvas, 0, 0, dom.displayCanvas.width, dom.displayCanvas.height);
    }

    // ═══════════════════════════════════════════
    // Pixelation Engine
    // ═══════════════════════════════════════════

    /**
     * Apply pixelation effect in a circular region on the full-res canvas.
     * @param {number} cx  Center X (full-res coords)
     * @param {number} cy  Center Y (full-res coords)
     * @param {number} radius  Radius (full-res coords)
     * @param {number} blockSize  Pixel block size
     */
    function pixelateRegion(cx, cy, radius, blockSize) {
        const w = fullResCanvas.width;
        const h = fullResCanvas.height;

        // Bounding box (clamped)
        const x0 = Math.max(0, Math.floor(cx - radius));
        const y0 = Math.max(0, Math.floor(cy - radius));
        const x1 = Math.min(w, Math.ceil(cx + radius));
        const y1 = Math.min(h, Math.ceil(cy + radius));

        if (x1 <= x0 || y1 <= y0) return;

        const imageData = fullResCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
        const data = imageData.data;
        const regionW = x1 - x0;
        const regionH = y1 - y0;
        const rSq = radius * radius;

        // Process each block
        for (let by = 0; by < regionH; by += blockSize) {
            for (let bx = 0; bx < regionW; bx += blockSize) {
                const bw = Math.min(blockSize, regionW - bx);
                const bh = Math.min(blockSize, regionH - by);

                // Check if block center is inside the circle
                const blockCX = x0 + bx + bw / 2;
                const blockCY = y0 + by + bh / 2;
                const dx = blockCX - cx;
                const dy = blockCY - cy;
                if (dx * dx + dy * dy > rSq) continue;

                // Compute average color for this block
                let r = 0, g = 0, b = 0, a = 0, count = 0;
                for (let py = by; py < by + bh; py++) {
                    for (let px = bx; px < bx + bw; px++) {
                        const idx = (py * regionW + px) * 4;
                        r += data[idx];
                        g += data[idx + 1];
                        b += data[idx + 2];
                        a += data[idx + 3];
                        count++;
                    }
                }
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
                a = Math.round(a / count);

                // Fill block with average color
                for (let py = by; py < by + bh; py++) {
                    for (let px = bx; px < bx + bw; px++) {
                        const idx = (py * regionW + px) * 4;
                        data[idx] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = a;
                    }
                }
            }
        }

        fullResCtx.putImageData(imageData, x0, y0);
    }

    /**
     * Apply pixelation effect within a rectangular area on the full-res canvas.
     * @param {number} rx0  Left X (full-res coords)
     * @param {number} ry0  Top Y (full-res coords)
     * @param {number} rx1  Right X (full-res coords)
     * @param {number} ry1  Bottom Y (full-res coords)
     * @param {number} blockSize  Pixel block size
     */
    function pixelateRect(rx0, ry0, rx1, ry1, blockSize) {
        const w = fullResCanvas.width;
        const h = fullResCanvas.height;

        // Normalize & clamp
        const x0 = Math.max(0, Math.floor(Math.min(rx0, rx1)));
        const y0 = Math.max(0, Math.floor(Math.min(ry0, ry1)));
        const x1 = Math.min(w, Math.ceil(Math.max(rx0, rx1)));
        const y1 = Math.min(h, Math.ceil(Math.max(ry0, ry1)));

        if (x1 <= x0 || y1 <= y0) return;

        const imageData = fullResCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
        const data = imageData.data;
        const regionW = x1 - x0;
        const regionH = y1 - y0;

        for (let by = 0; by < regionH; by += blockSize) {
            for (let bx = 0; bx < regionW; bx += blockSize) {
                const bw = Math.min(blockSize, regionW - bx);
                const bh = Math.min(blockSize, regionH - by);

                let r = 0, g = 0, b = 0, a = 0, count = 0;
                for (let py = by; py < by + bh; py++) {
                    for (let px = bx; px < bx + bw; px++) {
                        const idx = (py * regionW + px) * 4;
                        r += data[idx];
                        g += data[idx + 1];
                        b += data[idx + 2];
                        a += data[idx + 3];
                        count++;
                    }
                }
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);
                a = Math.round(a / count);

                for (let py = by; py < by + bh; py++) {
                    for (let px = bx; px < bx + bw; px++) {
                        const idx = (py * regionW + px) * 4;
                        data[idx] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = a;
                    }
                }
            }
        }

        fullResCtx.putImageData(imageData, x0, y0);
    }

    // ═══════════════════════════════════════════
    // Brush / Painting
    // ═══════════════════════════════════════════

    /**
     * Convert mouse position on the display canvas to full-res coordinates.
     * @param {MouseEvent|Touch} e
     * @returns {{ x: number, y: number }}
     */
    function toFullResCoords(e) {
        const rect = dom.displayCanvas.getBoundingClientRect();
        const displayX = e.clientX - rect.left;
        const displayY = e.clientY - rect.top;
        return {
            x: displayX / state.scaleFactor,
            y: displayY / state.scaleFactor,
        };
    }

    /**
     * Get the brush radius in full-res pixel coordinates.
     * @returns {number}
     */
    function fullResBrushRadius() {
        return state.brushRadius / state.scaleFactor;
    }

    /**
     * Save the current full-res canvas state for undo (only the affected bounding box).
     */
    function pushUndoSnapshot() {
        // Save the entire canvas for simplicity and correctness across strokes
        const data = fullResCtx.getImageData(0, 0, fullResCanvas.width, fullResCanvas.height);
        state.undoStack.push(data);
        // Limit stack to 30 entries to avoid excessive memory use
        if (state.undoStack.length > 30) {
            state.undoStack.shift();
        }
        updateUndoButton();
    }

    /**
     * Paint pixelation at a position, with interpolation from last position.
     * @param {number} fullX
     * @param {number} fullY
     */
    function paintAt(fullX, fullY) {
        const radius = fullResBrushRadius();
        const blockSize = state.blockSize;

        if (state.lastPaintPos) {
            // Interpolate between last position and current for smooth strokes
            const dx = fullX - state.lastPaintPos.x;
            const dy = fullY - state.lastPaintPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const step = Math.max(blockSize / 2, 3);

            if (dist > step) {
                const steps = Math.ceil(dist / step);
                for (let i = 1; i < steps; i++) {
                    const t = i / steps;
                    pixelateRegion(
                        state.lastPaintPos.x + dx * t,
                        state.lastPaintPos.y + dy * t,
                        radius,
                        blockSize
                    );
                }
            }
        }

        pixelateRegion(fullX, fullY, radius, blockSize);
        state.lastPaintPos = { x: fullX, y: fullY };

        // Sync display
        syncDisplayCanvas();
    }

    // ═══════════════════════════════════════════
    // Undo / Reset
    // ═══════════════════════════════════════════

    function undo() {
        if (state.undoStack.length === 0) return;
        const snapshot = state.undoStack.pop();
        fullResCtx.putImageData(snapshot, 0, 0);
        syncDisplayCanvas();
        updateUndoButton();
        updateStatusBar();
    }

    function resetImage() {
        if (!state.originalImage) return;
        state.undoStack = [];
        fullResCtx.drawImage(state.originalImage, 0, 0);
        syncDisplayCanvas();
        updateUndoButton();
        updateStatusBar();
    }

    // ═══════════════════════════════════════════
    // Export
    // ═══════════════════════════════════════════

    function exportPNG() {
        fullResCanvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'pixelbrush_export.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }, 'image/png');
    }

    // ═══════════════════════════════════════════
    // UI Helpers
    // ═══════════════════════════════════════════

    function updateUndoButton() {
        dom.btnUndo.disabled = state.undoStack.length === 0;
    }

    function updateStatusBar() {
        if (!state.originalImage) return;
        const w = state.originalImage.naturalWidth;
        const h = state.originalImage.naturalHeight;
        dom.statusDims.textContent = `${w} × ${h} px`;
        dom.statusZoom.textContent = `Zoom: ${Math.round(state.scaleFactor * 100)}%`;
        dom.statusUndo.textContent = `Deshacer: ${state.undoStack.length}`;
    }

    function updateBrushCursor(e) {
        const rect = dom.canvasWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const size = state.brushRadius * 2;
        dom.brushCursor.style.width = `${size}px`;
        dom.brushCursor.style.height = `${size}px`;
        dom.brushCursor.style.left = `${x}px`;
        dom.brushCursor.style.top = `${y}px`;
    }

    /**
     * Switch the active tool and update UI accordingly.
     * @param {'brush'|'zone'} tool
     */
    function setActiveTool(tool) {
        state.activeTool = tool;

        // Toggle button states
        dom.toolBrush.classList.toggle('active', tool === 'brush');
        dom.toolZone.classList.toggle('active', tool === 'zone');

        // Toggle canvas wrapper cursor class
        dom.canvasWrapper.classList.toggle('zone-mode', tool === 'zone');

        // Show/hide brush size control
        if (dom.brushSizeGroup) {
            dom.brushSizeGroup.style.display = tool === 'zone' ? 'none' : '';
        }

        // Clean up any in-progress selection
        hideSelectionRect();
        state.isSelecting = false;
        state.selectionStart = null;
        state.selectionEnd = null;
    }

    /**
     * Show the selection rectangle overlay at the given display-space coordinates.
     */
    function updateSelectionRect(x0, y0, x1, y1) {
        const canvasRect = dom.displayCanvas.getBoundingClientRect();
        const wrapperRect = dom.canvasWrapper.getBoundingClientRect();

        // Offset from wrapper to canvas
        const offsetX = canvasRect.left - wrapperRect.left;
        const offsetY = canvasRect.top - wrapperRect.top;

        const left = Math.min(x0, x1);
        const top = Math.min(y0, y1);
        const width = Math.abs(x1 - x0);
        const height = Math.abs(y1 - y0);

        dom.selectionRect.style.left = `${offsetX + left}px`;
        dom.selectionRect.style.top = `${offsetY + top}px`;
        dom.selectionRect.style.width = `${width}px`;
        dom.selectionRect.style.height = `${height}px`;
        dom.selectionRect.classList.remove('hidden');
    }

    function hideSelectionRect() {
        dom.selectionRect.classList.add('hidden');
    }

    /**
     * Convert display-space coordinates to full-res coordinates.
     */
    function displayToFullRes(x, y) {
        return {
            x: x / state.scaleFactor,
            y: y / state.scaleFactor,
        };
    }

    // ═══════════════════════════════════════════
    // Event Handlers
    // ═══════════════════════════════════════════

    // File upload button
    dom.btnUpload.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) loadImageFile(e.target.files[0]);
    });

    // Drag and drop
    let dragCounter = 0;

    dom.main.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        dom.dropOverlay.classList.remove('hidden');
    });

    dom.main.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dom.dropOverlay.classList.add('hidden');
        }
    });

    dom.main.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    dom.main.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        dom.dropOverlay.classList.add('hidden');
        const file = e.dataTransfer.files[0];
        if (file) loadImageFile(file);
    });

    // Paste from clipboard
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                loadImageFile(item.getAsFile());
                return;
            }
        }
    });

    // Sliders
    dom.brushSize.addEventListener('input', (e) => {
        state.brushRadius = parseInt(e.target.value, 10);
        dom.brushSizeVal.textContent = `${state.brushRadius}px`;
    });

    dom.pixelSize.addEventListener('input', (e) => {
        state.blockSize = parseInt(e.target.value, 10);
        dom.pixelSizeVal.textContent = `${state.blockSize}px`;
    });

    // Action buttons
    dom.btnUndo.addEventListener('click', undo);
    dom.btnReset.addEventListener('click', resetImage);
    dom.btnExport.addEventListener('click', exportPNG);

    // Tool toggle
    dom.toolBrush.addEventListener('click', () => setActiveTool('brush'));
    dom.toolZone.addEventListener('click', () => setActiveTool('zone'));

    // ─── Canvas mouse events ───
    dom.displayCanvas.addEventListener('mousedown', (e) => {
        if (!state.hasImage || e.button !== 0) return;

        if (state.activeTool === 'brush') {
            state.isPainting = true;
            state.lastPaintPos = null;
            pushUndoSnapshot();
            const pos = toFullResCoords(e);
            paintAt(pos.x, pos.y);
        } else if (state.activeTool === 'zone') {
            const rect = dom.displayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            state.isSelecting = true;
            state.selectionStart = { x, y };
            state.selectionEnd = { x, y };
            updateSelectionRect(x, y, x, y);
        }
    });

    dom.displayCanvas.addEventListener('mousemove', (e) => {
        if (state.activeTool === 'brush') {
            updateBrushCursor(e);
            if (!state.isPainting) return;
            const pos = toFullResCoords(e);
            paintAt(pos.x, pos.y);
        } else if (state.activeTool === 'zone' && state.isSelecting) {
            const rect = dom.displayCanvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, dom.displayCanvas.width));
            const y = Math.max(0, Math.min(e.clientY - rect.top, dom.displayCanvas.height));
            state.selectionEnd = { x, y };
            updateSelectionRect(
                state.selectionStart.x, state.selectionStart.y,
                x, y
            );
        }
    });

    window.addEventListener('mouseup', () => {
        if (state.activeTool === 'brush' && state.isPainting) {
            state.isPainting = false;
            state.lastPaintPos = null;
            updateStatusBar();
        } else if (state.activeTool === 'zone' && state.isSelecting) {
            state.isSelecting = false;
            hideSelectionRect();

            if (state.selectionStart && state.selectionEnd) {
                const s = state.selectionStart;
                const end = state.selectionEnd;
                const minDist = 4;
                if (Math.abs(end.x - s.x) > minDist && Math.abs(end.y - s.y) > minDist) {
                    const p0 = displayToFullRes(s.x, s.y);
                    const p1 = displayToFullRes(end.x, end.y);
                    pushUndoSnapshot();
                    pixelateRect(p0.x, p0.y, p1.x, p1.y, state.blockSize);
                    syncDisplayCanvas();
                    updateStatusBar();
                }
            }

            state.selectionStart = null;
            state.selectionEnd = null;
        }
    });

    // ─── Canvas touch events ───
    dom.displayCanvas.addEventListener('touchstart', (e) => {
        if (!state.hasImage) return;
        e.preventDefault();

        if (state.activeTool === 'brush') {
            state.isPainting = true;
            state.lastPaintPos = null;
            pushUndoSnapshot();
            const touch = e.touches[0];
            const pos = toFullResCoords(touch);
            paintAt(pos.x, pos.y);
        } else if (state.activeTool === 'zone') {
            const touch = e.touches[0];
            const rect = dom.displayCanvas.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;
            state.isSelecting = true;
            state.selectionStart = { x, y };
            state.selectionEnd = { x, y };
            updateSelectionRect(x, y, x, y);
        }
    }, { passive: false });

    dom.displayCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (state.activeTool === 'brush') {
            if (!state.isPainting) return;
            const touch = e.touches[0];
            const pos = toFullResCoords(touch);
            paintAt(pos.x, pos.y);
        } else if (state.activeTool === 'zone' && state.isSelecting) {
            const touch = e.touches[0];
            const rect = dom.displayCanvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(touch.clientX - rect.left, dom.displayCanvas.width));
            const y = Math.max(0, Math.min(touch.clientY - rect.top, dom.displayCanvas.height));
            state.selectionEnd = { x, y };
            updateSelectionRect(
                state.selectionStart.x, state.selectionStart.y,
                x, y
            );
        }
    }, { passive: false });

    dom.displayCanvas.addEventListener('touchend', () => {
        if (state.activeTool === 'brush') {
            state.isPainting = false;
            state.lastPaintPos = null;
            updateStatusBar();
        } else if (state.activeTool === 'zone' && state.isSelecting) {
            state.isSelecting = false;
            hideSelectionRect();

            if (state.selectionStart && state.selectionEnd) {
                const s = state.selectionStart;
                const end = state.selectionEnd;
                const minDist = 4;
                if (Math.abs(end.x - s.x) > minDist && Math.abs(end.y - s.y) > minDist) {
                    const p0 = displayToFullRes(s.x, s.y);
                    const p1 = displayToFullRes(end.x, end.y);
                    pushUndoSnapshot();
                    pixelateRect(p0.x, p0.y, p1.x, p1.y, state.blockSize);
                    syncDisplayCanvas();
                    updateStatusBar();
                }
            }

            state.selectionStart = null;
            state.selectionEnd = null;
        }
    });

    // ─── Brush cursor on wrapper ───
    dom.canvasWrapper.addEventListener('mousemove', (e) => {
        if (state.activeTool === 'brush') updateBrushCursor(e);
    });

    dom.canvasWrapper.addEventListener('mouseenter', () => {
        if (state.activeTool === 'brush') {
            dom.brushCursor.style.opacity = '1';
            dom.displayCanvas.style.cursor = 'none';
        }
    });

    dom.canvasWrapper.addEventListener('mouseleave', () => {
        dom.brushCursor.style.opacity = '0';
        dom.displayCanvas.style.cursor = 'default';
    });

    // ─── Window resize ───
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            fitDisplayCanvas();
            updateStatusBar();
        }, 150);
    });

    // ─── Keyboard shortcuts ───
    document.addEventListener('keydown', (e) => {
        // Ctrl+Z = undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
        }
        // B = brush tool, Z = zone tool (when not combined with Ctrl)
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (e.key === 'b' || e.key === 'B') setActiveTool('brush');
            if (e.key === 'r' || e.key === 'R') setActiveTool('zone');
        }
    });

})();
