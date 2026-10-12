import React, { useRef, useEffect, useState } from "react"
import { type StrokePayload, GAME_CONSTANTS } from "./types"

interface CanvasProps {
  isDrawer: boolean
  onStrokeEmitted: (stroke: StrokePayload) => void
  initialHistory: StrokePayload[]
  onStrokeReceivedRef: React.MutableRefObject<
    ((stroke: StrokePayload) => void) | null
  >
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
  const [brushColor, setBrushColor] = useState("#000000")
  const [brushSize, setBrushSize] = useState(4)
  const [activeTool, setActiveTool] = useState<"pen" | "eraser">("pen")
  const localPoints = useRef<{ x: number; y: number }[]>([])

  // Track client-side undo stacks locally
  const strokeHistoryStack = useRef<StrokePayload[]>([])

  const drawRawStroke = (
    ctx: CanvasRenderingContext2D | null,
    stroke: StrokePayload,
  ) => {
    if (!ctx) return
    if (stroke.tool === "clear") {
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(
        0,
        0,
        GAME_CONSTANTS.CANVAS_DEFAULT_WIDTH,
        GAME_CONSTANTS.CANVAS_DEFAULT_HEIGHT,
      )
      return
    }
    if (!stroke.points || stroke.points.length === 0) return

    ctx.strokeStyle = stroke.tool === "eraser" ? "#ffffff" : stroke.color
    ctx.lineWidth = stroke.size
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
    ctx.fillRect(
      0,
      0,
      GAME_CONSTANTS.CANVAS_DEFAULT_WIDTH,
      GAME_CONSTANTS.CANVAS_DEFAULT_HEIGHT,
    )
    strokeHistoryStack.current.forEach((s) => drawRawStroke(ctx, s))
  }

  useEffect(() => {
    const canvas = canvasRef.current!
    canvas.width = GAME_CONSTANTS.CANVAS_DEFAULT_WIDTH * 2
    canvas.height = GAME_CONSTANTS.CANVAS_DEFAULT_HEIGHT * 2
    canvas.style.width = `${GAME_CONSTANTS.CANVAS_DEFAULT_WIDTH}px`
    canvas.style.height = `${GAME_CONSTANTS.CANVAS_DEFAULT_HEIGHT}px`

    const ctx = canvas.getContext("2d")!
    ctx.scale(2, 2)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    contextRef.current = ctx

    ctx.fillStyle = "#ffffff"
    ctx.fillRect(
      0,
      0,
      GAME_CONSTANTS.CANVAS_DEFAULT_WIDTH,
      GAME_CONSTANTS.CANVAS_DEFAULT_HEIGHT,
    )

    strokeHistoryStack.current = [...initialHistory]
    redrawCanvasFromStack()

    onStrokeReceivedRef.current = (stroke: StrokePayload) => {
      if (stroke.tool === "undo") {
        strokeHistoryStack.current.pop()
        redrawCanvasFromStack()
      } else if (stroke.tool === "clear") {
        strokeHistoryStack.current = []
        redrawCanvasFromStack()
      } else {
        strokeHistoryStack.current.push(stroke)
        drawRawStroke(contextRef.current, stroke)
      }
    }
  }, [initialHistory, onStrokeReceivedRef])

  const triggerUndoAction = () => {
    if (!isDrawer) return
    strokeHistoryStack.current.pop()
    redrawCanvasFromStack()
    onStrokeEmitted({ points: [], color: "", size: 0, tool: "undo" })
  }

  const triggerClearAction = () => {
    if (!isDrawer) return
    strokeHistoryStack.current = []
    redrawCanvasFromStack()
    onStrokeEmitted({ points: [], color: "", size: 0, tool: "clear" })
  }

  const startTracking = ({ nativeEvent }: React.MouseEvent) => {
    if (!isDrawer) return
    const { offsetX, offsetY } = nativeEvent
    contextRef.current!.strokeStyle =
      activeTool === "eraser" ? "#ffffff" : brushColor
    contextRef.current!.lineWidth = brushSize
    contextRef.current!.beginPath()
    contextRef.current!.moveTo(offsetX, offsetY)
    setIsDrawing(true)
    localPoints.current = [{ x: offsetX, y: offsetY }]
  }

  const drawMove = ({ nativeEvent }: React.MouseEvent) => {
    if (!isDrawing || !isDrawer) return
    const { offsetX, offsetY } = nativeEvent
    contextRef.current!.lineTo(offsetX, offsetY)
    contextRef.current!.stroke()
    localPoints.current.push({ x: offsetX, y: offsetY })
  }

  const stopTracking = () => {
    if (!isDrawing || !isDrawer) return
    setIsDrawing(false)
    const newStroke: StrokePayload = {
      points: localPoints.current,
      color: brushColor,
      size: brushSize,
      tool: activeTool,
    }
    strokeHistoryStack.current.push(newStroke)
    onStrokeEmitted(newStroke)
    localPoints.current = []
  }

  return (
    <div
      style={{
        background: "#fff",
        padding: "12px",
        borderRadius: "8px",
        border: "1px solid #ccc",
      }}
    >
      {isDrawer && (
        <div
          style={{
            display: "flex",
            gap: "10px",
            marginBottom: "10px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <input
            type="color"
            value={brushColor}
            onChange={(e) => setBrushColor(e.target.value)}
            disabled={activeTool === "eraser"}
          />
          <input
            type="range"
            min="2"
            max="25"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
          <button
            onClick={() => setActiveTool("pen")}
            style={{
              background: activeTool === "pen" ? "#ddd" : "#fff",
              padding: "4px 8px",
            }}
          >
            ✏️ Pen
          </button>
          <button
            onClick={() => setActiveTool("eraser")}
            style={{
              background: activeTool === "eraser" ? "#ddd" : "#fff",
              padding: "4px 8px",
            }}
          >
            🧽 Eraser
          </button>
          <button onClick={triggerUndoAction} style={{ padding: "4px 8px" }}>
            ↩️ Undo
          </button>
          <button
            onClick={triggerClearAction}
            style={{ padding: "4px 8px", color: "red" }}
          >
            🗑️ Clear
          </button>
        </div>
      )}
      <canvas
        ref={canvasRef}
        onMouseDown={startTracking}
        onMouseMove={drawMove}
        onMouseUp={stopTracking}
        onMouseLeave={stopTracking}
        style={{
          border: "1px solid #aaa",
          cursor: isDrawer ? "crosshair" : "not-allowed",
          background: "#fff",
        }}
      />
    </div>
  )
}
