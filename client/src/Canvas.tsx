import React, { useEffect, useRef, useState } from "react"
import { type StrokePayload, GAME_CONSTANTS } from "./types"

interface CanvasProps {
  isDrawer: boolean
  onStrokeEmitted: (stroke: StrokePayload) => void
  initialHistory: StrokePayload[]
  onStrokeReceivedRef: React.MutableRefObject<
    ((stroke: StrokePayload) => void) | null
  >
}

const COLORS = [
  "#1a1a1a",
  "#e63946",
  "#f4a261",
  "#e9c46a",
  "#2a9d8f",
  "#457b9d",
  "#7b2cbf",
  "#ffffff",
]

function newStrokeId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10)
}

export const Canvas: React.FC<CanvasProps> = ({
  isDrawer,
  onStrokeEmitted,
  initialHistory,
  onStrokeReceivedRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [brushColor, setBrushColor] = useState("#1a1a1a")
  const [brushSize, setBrushSize] = useState(4)
  const [activeTool, setActiveTool] = useState<"pen" | "eraser" | "fill">(
    "pen",
  )

  const localPoints = useRef<{ x: number; y: number }[]>([])
  const pendingPoints = useRef<{ x: number; y: number }[]>([])
  const activeStrokeId = useRef<string | null>(null)
  const lastFlush = useRef(0)
  const strokeHistoryStack = useRef<StrokePayload[]>([])
  const inProgress = useRef<Map<string, StrokePayload>>(new Map())

  const drawRawStroke = (
    ctx: CanvasRenderingContext2D | null,
    stroke: StrokePayload,
  ) => {
    if (!ctx) return
    if (stroke.tool === "clear") {
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, GAME_CONSTANTS.CANVAS_WIDTH, GAME_CONSTANTS.CANVAS_HEIGHT)
      return
    }
    if (stroke.tool === "fill" && stroke.points?.[0]) {
      floodFill(
        ctx,
        Math.floor(stroke.points[0].x),
        Math.floor(stroke.points[0].y),
        stroke.color,
      )
      return
    }
    if (!stroke.points || stroke.points.length === 0) return

    ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color
    ctx.lineWidth = stroke.size
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
    }
    ctx.stroke()
  }

  const redrawCanvasFromStack = () => {
    const ctx = contextRef.current
    if (!ctx) return
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, GAME_CONSTANTS.CANVAS_WIDTH, GAME_CONSTANTS.CANVAS_HEIGHT)
    for (const s of strokeHistoryStack.current) {
      drawRawStroke(ctx, s)
    }
  }

  const applyRemoteStroke = (stroke: StrokePayload) => {
    if (stroke.tool === "undo") {
      strokeHistoryStack.current.pop()
      inProgress.current.clear()
      redrawCanvasFromStack()
      return
    }
    if (stroke.tool === "clear") {
      strokeHistoryStack.current = []
      inProgress.current.clear()
      redrawCanvasFromStack()
      return
    }

    const id = stroke.strokeId
    if (id && stroke.phase && stroke.phase !== "end") {
      const prev = inProgress.current.get(id)
      const mergedPoints = prev
        ? [...prev.points, ...stroke.points]
        : [...stroke.points]
      const merged: StrokePayload = { ...stroke, points: mergedPoints }
      inProgress.current.set(id, merged)
      // Draw only the new segment for low latency
      if (stroke.points.length) {
        const ctx = contextRef.current
        if (ctx && stroke.tool !== "fill") {
          ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color
          ctx.lineWidth = stroke.size
          ctx.lineCap = "round"
          ctx.lineJoin = "round"
          const start =
            prev && prev.points.length
              ? prev.points[prev.points.length - 1]
              : stroke.points[0]
          ctx.beginPath()
          ctx.moveTo(start.x, start.y)
          for (const p of stroke.points) {
            ctx.lineTo(p.x, p.y)
          }
          ctx.stroke()
        } else if (stroke.tool === "fill") {
          drawRawStroke(contextRef.current, stroke)
        }
      }
      return
    }

    if (id) inProgress.current.delete(id)
    strokeHistoryStack.current.push(stroke)
    if (stroke.phase === "end" && stroke.tool !== "fill") {
      // Already partially drawn; redraw to settle
      redrawCanvasFromStack()
    } else {
      drawRawStroke(contextRef.current, stroke)
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = GAME_CONSTANTS.CANVAS_WIDTH * dpr
    canvas.height = GAME_CONSTANTS.CANVAS_HEIGHT * dpr
    // Display size is controlled by CSS so the board scales on small screens
    canvas.style.width = "100%"
    canvas.style.height = "auto"

    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    contextRef.current = ctx

    strokeHistoryStack.current = initialHistory.filter(
      (s) => !s.phase || s.phase === "end" || s.tool === "fill" || s.tool === "clear",
    )
    // Include latest in-progress strokes from history
    const latestById = new Map<string, StrokePayload>()
    for (const s of initialHistory) {
      if (s.strokeId && s.phase && s.phase !== "end") {
        latestById.set(s.strokeId, s)
      }
    }
    for (const s of latestById.values()) {
      strokeHistoryStack.current.push(s)
    }

    redrawCanvasFromStack()
    onStrokeReceivedRef.current = applyRemoteStroke
  }, [initialHistory, onStrokeReceivedRef])

  const pointerPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * GAME_CONSTANTS.CANVAS_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * GAME_CONSTANTS.CANVAS_HEIGHT,
    }
  }

  const flushPending = (phase: "move" | "end") => {
    if (!activeStrokeId.current) return

    if (phase === "move") {
      const batch = pendingPoints.current
      if (batch.length === 0) return
      pendingPoints.current = []
      onStrokeEmitted({
        points: batch,
        color: brushColor,
        size: brushSize,
        tool: activeTool,
        strokeId: activeStrokeId.current,
        phase: "move",
      })
      return
    }

    // Server already accumulated streamed points; end can be a small seal packet
    const stroke: StrokePayload = {
      points: pendingPoints.current.length
        ? [...pendingPoints.current]
        : localPoints.current.slice(-1),
      color: brushColor,
      size: brushSize,
      tool: activeTool,
      strokeId: activeStrokeId.current,
      phase: "end",
    }
    strokeHistoryStack.current.push({
      ...stroke,
      points: [...localPoints.current],
    })
    onStrokeEmitted(stroke)
    activeStrokeId.current = null
    localPoints.current = []
    pendingPoints.current = []
  }

  const startTracking = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawer) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pos = pointerPos(e)

    if (activeTool === "fill") {
      const stroke: StrokePayload = {
        points: [pos],
        color: brushColor,
        size: 1,
        tool: "fill",
        phase: "end",
        strokeId: newStrokeId(),
      }
      drawRawStroke(contextRef.current, stroke)
      strokeHistoryStack.current.push(stroke)
      onStrokeEmitted(stroke)
      return
    }

    const id = newStrokeId()
    activeStrokeId.current = id
    localPoints.current = [pos]
    pendingPoints.current = [pos]
    lastFlush.current = performance.now()
    setIsDrawing(true)

    const ctx = contextRef.current!
    ctx.strokeStyle = activeTool === "eraser" ? "#ffffff" : brushColor
    ctx.lineWidth = brushSize
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)

    onStrokeEmitted({
      points: [pos],
      color: brushColor,
      size: brushSize,
      tool: activeTool,
      strokeId: id,
      phase: "begin",
    })
  }

  const drawMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !isDrawer || activeTool === "fill") return
    const pos = pointerPos(e)
    const ctx = contextRef.current!
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)

    localPoints.current.push(pos)
    pendingPoints.current.push(pos)

    const now = performance.now()
    if (
      pendingPoints.current.length >= GAME_CONSTANTS.STREAM_POINT_BATCH ||
      now - lastFlush.current >= GAME_CONSTANTS.STREAM_INTERVAL_MS
    ) {
      flushPending("move")
      lastFlush.current = now
    }
  }

  const stopTracking = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !isDrawer) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setIsDrawing(false)
    flushPending("end")
  }

  const triggerUndoAction = () => {
    if (!isDrawer) return
    strokeHistoryStack.current.pop()
    redrawCanvasFromStack()
    onStrokeEmitted({ points: [], color: "", size: 0, tool: "undo", phase: "end" })
  }

  const triggerClearAction = () => {
    if (!isDrawer) return
    strokeHistoryStack.current = []
    redrawCanvasFromStack()
    onStrokeEmitted({ points: [], color: "", size: 0, tool: "clear", phase: "end" })
  }

  return (
    <div className="canvas-panel">
      {isDrawer && (
        <div className="toolbar">
          <div className="tool-group">
            {(
              [
                ["pen", "Pen"],
                ["eraser", "Eraser"],
                ["fill", "Fill"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`tool-btn ${activeTool === id ? "active" : ""}`}
                onClick={() => setActiveTool(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="color-row">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch ${brushColor === c ? "selected" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  setBrushColor(c)
                  if (activeTool === "eraser") setActiveTool("pen")
                }}
                aria-label={`Color ${c}`}
              />
            ))}
            <input
              type="color"
              value={brushColor}
              onChange={(e) => setBrushColor(e.target.value)}
              className="color-picker"
              title="Custom color"
            />
          </div>

          <label className="size-control">
            Size
            <input
              type="range"
              min={2}
              max={32}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
            <span>{brushSize}</span>
          </label>

          <div className="tool-group">
            <button type="button" className="tool-btn" onClick={triggerUndoAction}>
              Undo
            </button>
            <button
              type="button"
              className="tool-btn danger"
              onClick={triggerClearAction}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={`game-canvas ${isDrawer ? "drawable" : ""}`}
        onPointerDown={startTracking}
        onPointerMove={drawMove}
        onPointerUp={stopTracking}
        onPointerLeave={(e) => {
          if (isDrawing) stopTracking(e)
        }}
      />
    </div>
  )
}

/** Scanline flood fill using device pixels (accounts for DPR transform). */
function floodFill(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  fillColor: string,
) {
  const canvas = ctx.canvas
  const dpr = canvas.width / GAME_CONSTANTS.CANVAS_WIDTH
  const w = canvas.width
  const h = canvas.height
  const sx = Math.floor(startX * dpr)
  const sy = Math.floor(startY * dpr)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return

  // Read/write in identity space so DPR transform does not skew sampling
  const prev = ctx.getTransform()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const image = ctx.getImageData(0, 0, w, h)
  const data = image.data
  const idx = (x: number, y: number) => (y * w + x) * 4

  const target = idx(sx, sy)
  const tr = data[target]
  const tg = data[target + 1]
  const tb = data[target + 2]
  const ta = data[target + 3]

  const fill = hexToRgba(fillColor)
  if (tr === fill[0] && tg === fill[1] && tb === fill[2] && ta === fill[3]) {
    ctx.setTransform(prev)
    return
  }

  const match = (x: number, y: number) => {
    const i = idx(x, y)
    return (
      data[i] === tr &&
      data[i + 1] === tg &&
      data[i + 2] === tb &&
      data[i + 3] === ta
    )
  }

  const stack: [number, number][] = [[sx, sy]]
  let guard = w * h
  while (stack.length && guard-- > 0) {
    const [x, y] = stack.pop()!
    if (x < 0 || y < 0 || x >= w || y >= h || !match(x, y)) continue
    let left = x
    while (left > 0 && match(left - 1, y)) left--
    let right = x
    while (right < w - 1 && match(right + 1, y)) right++
    for (let i = left; i <= right; i++) {
      const p = idx(i, y)
      data[p] = fill[0]
      data[p + 1] = fill[1]
      data[p + 2] = fill[2]
      data[p + 3] = fill[3]
      if (y > 0 && match(i, y - 1)) stack.push([i, y - 1])
      if (y < h - 1 && match(i, y + 1)) stack.push([i, y + 1])
    }
  }
  ctx.putImageData(image, 0, 0)
  ctx.setTransform(prev)
}

function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace("#", "")
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("")
  }
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
}
