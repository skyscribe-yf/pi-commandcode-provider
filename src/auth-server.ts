/**
 * Local HTTP callback server for the Command Code browser auth flow.
 *
 * Starts a one-shot server on a random port. The Command Code Studio
 * website POSTs the user's API key to /callback after they authenticate.
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface AuthCallback {
  apiKey: string
  state: string
  userId: string
  userName: string
  keyName: string
}

export interface AuthServer {
  server: Server
  port: number
  waitForCallback: Promise<AuthCallback>
}

/**
 * Start a local HTTP server that listens for the Command Code Studio
 * to POST the API key after the user authenticates in their browser.
 *
 * The server accepts exactly one valid POST to /callback and then closes.
 */
export function startAuthServer(): Promise<AuthServer> {
  let resolveCallback: (value: AuthCallback) => void
  let rejectCallback: (error: Error) => void

  const waitForCallback = new Promise<AuthCallback>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req, res) => {
    // CORS: allow requests from Command Code domains and localhost for dev
    const origin = req.headers.origin || ""
    const allowedOrigins = [
      "http://localhost:3000",
      "https://staging.commandcode.ai",
      "https://commandcode.ai",
    ]
    const responseOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0]

    res.setHeader("Access-Control-Allow-Origin", responseOrigin)
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Content-Type", "application/json")

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url !== "/callback") {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: "Not found" }))
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405)
      res.end(
        JSON.stringify({
          success: false,
          error: "Method not allowed. Use POST.",
        }),
      )
      return
    }

    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
      if (body.length > 10_000) req.destroy()
    })

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>

        if (parsed.error) {
          res.writeHead(200)
          res.end(JSON.stringify({ success: true }))
          const description =
            typeof parsed.error_description === "string"
              ? parsed.error_description
              : String(parsed.error)
          if (parsed.error === "access_denied") {
            rejectCallback(new Error(description || "Authorization was denied by the user"))
          } else {
            rejectCallback(new Error(description || String(parsed.error)))
          }
          server.close()
          return
        }

        const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : ""
        const state = typeof parsed.state === "string" ? parsed.state : ""
        const userId = typeof parsed.userId === "string" ? parsed.userId : ""
        const userName = typeof parsed.userName === "string" ? parsed.userName : ""
        const keyName = typeof parsed.keyName === "string" ? parsed.keyName : ""

        if (!apiKey || !state || !userId || !userName || !keyName) {
          res.writeHead(400)
          res.end(
            JSON.stringify({
              success: false,
              error: "Missing required fields",
            }),
          )
          return
        }

        res.writeHead(200)
        res.end(JSON.stringify({ success: true }))

        resolveCallback({ apiKey, state, userId, userName, keyName })
        server.close()
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }))
      }
    })

    req.on("error", () => {
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: "Request error" }))
    })
  })

  return new Promise((resolve) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      rejectCallback(new Error(`Failed to start auth server: ${err.message}`))
    })

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo
      resolve({ server, port: address.port, waitForCallback })
    })
  })
}
