import { io } from "socket.io-client";

const gameName = import.meta.env.VITE_GAME_NAME || "cluey";

let socket;

export function getSocket() {
  if (!socket) {
    socket = io({
      path: `/${gameName}/socket.io`,
      autoConnect: true
    });
  }
  return socket;
}

export function closeSocket() {
  if (socket) {
    socket.disconnect();
    socket = undefined;
  }
}
