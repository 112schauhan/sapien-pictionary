export interface Point {
  x: number
  y: number
}

export interface StrokePayload {
  points: Point[]
  color: string
  size: number
}

export interface PlayerData {
  id: string
  name: string
  score: number
  is_host: boolean
  is_correct: boolean
}

export interface ChatMessage {
  sender?: string
  text: string
  system?: boolean
}

// Client Side Game State Operational Constants
export const GAME_CONSTANTS = {
  SERVER_WS_URL: "ws://127.0.0.1:8000/ws",
  DEFAULT_ROOM_ID: "windows-lounge",
  CANVAS_DEFAULT_WIDTH: 600,
  CANVAS_DEFAULT_HEIGHT: 400,
}
