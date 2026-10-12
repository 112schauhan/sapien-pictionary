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

// Define drawRawStroke ABOVE the useEffect block to resolve line 39 mutation hooks lint rules
const drawRawStroke = (
  ctx: CanvasRenderingContext2D | null,
  stroke: StrokePayload,
) => {
  if (!ctx || !stroke.points || stroke.points.length === 0) return
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.size
  ctx.beginPath()
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y)
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y)
  }
  ctx.stroke()
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
  const localPoints = useRef<{ x: number; y: number }[]>([])

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

    initialHistory.forEach((stroke) =>
      drawRawStroke(contextRef.current, stroke),
    )
    onStrokeReceivedRef.current = (stroke: StrokePayload) =>
      drawRawStroke(contextRef.current, stroke)
  }, [initialHistory, onStrokeReceivedRef])

  const startTracking = ({ nativeEvent }: React.MouseEvent) => {
    if (!isDrawer) return
    const { offsetX, offsetY } = nativeEvent
    contextRef.current!.strokeStyle = brushColor
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
    onStrokeEmitted({
      points: localPoints.current,
      color: brushColor,
      size: brushSize,
    })
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
            gap: "15px",
            marginBottom: "10px",
            alignItems: "center",
          }}
        >
          <input
            type="color"
            value={brushColor}
            onChange={(e) => setBrushColor(e.target.value)}
          />
          <input
            type="range"
            min="2"
            max="12"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
          <span style={{ fontSize: "12px" }}>Size: {brushSize}px</span>
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
