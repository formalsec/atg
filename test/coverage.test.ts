import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { matchEndpoints } from "../src/coverage.ts"

const origin = "http://localhost:4173"
const endpoints = ["POST /api/todos", "PATCH /api/todos/{id}", "GET /api/users/{id}", "GET /api/users/me"]

function match(...requests: [string, string, string?, string?][]) {
  return matchEndpoints(
    endpoints,
    origin,
    requests.map(([method, path, type = "fetch", unserved]) => ({ method, url: new URL(path, origin).href, type, unserved })),
  )
}

describe("api endpoint matching", () => {
  test("maps a concrete path to its template, ignores the query, and prefers a concrete path over a template", () => {
    const result = match(["PATCH", "/api/todos/42"], ["POST", "/api/todos?draft=1"], ["GET", "/api/users/me"])
    assert.deepEqual(result.covered, ["GET /api/users/me", "PATCH /api/todos/{id}", "POST /api/todos"])
    assert.deepEqual(result.uncovered, ["GET /api/users/{id}"])
    assert.deepEqual(result.endpoints, endpoints.toSorted())
  })

  test("needs the same method, and a parameter matches one path segment only", () => {
    const result = match(["PUT", "/api/todos/1"], ["GET", "/api/todos"], ["PATCH", "/api/todos/1/tags"], ["PATCH", "/api/todos/"])
    assert.deepEqual(result.covered, [])
    assert.deepEqual(result.unmatched, ["GET /api/todos", "PATCH /api/todos/", "PATCH /api/todos/1/tags", "PUT /api/todos/1"])
  })

  test("ignores page and asset loads, other origins and requests the app did not answer, and lists each one with why", () => {
    const result = match(
      ["GET", "/", "document"],
      ["GET", "/app.js", "script"],
      ["GET", "https://cdn.example.com/api/todos/1"],
      ["POST", "/api/todos", "fetch", "not served by the app"],
      ["PATCH", "/api/todos/1", "fetch", "failed: net::ERR_EMPTY_RESPONSE"],
    )
    assert.deepEqual(result.covered, [])
    assert.deepEqual(result.unmatched, [])
    assert.deepEqual(result.ignored, [
      "GET http://localhost:4173/ (document)",
      "GET http://localhost:4173/app.js (script)",
      "GET https://cdn.example.com/api/todos/1 (other origin)",
      "PATCH http://localhost:4173/api/todos/1 (failed: net::ERR_EMPTY_RESPONSE)",
      "POST http://localhost:4173/api/todos (not served by the app)",
    ])
  })

  test("reports every other request that matches no endpoint as unmatched, also a form post and an unknown asset path", () => {
    const result = match(["GET", "/api/stats"], ["POST", "/login", "document"], ["GET", "/favicon.ico", "other"])
    assert.deepEqual(result.unmatched, ["GET /api/stats", "GET /favicon.ico", "POST /login"])
    assert.deepEqual(result.ignored, [])
  })

  test("gives the same result for the same requests in any order, with each item once", () => {
    const requests: [string, string][] = [["PATCH", "/api/todos/2"], ["GET", "/api/stats"], ["PATCH", "/api/todos/1"], ["GET", "/api/stats"]]
    assert.deepEqual(match(...requests), match(...requests.toReversed()))
    assert.deepEqual(match(...requests).unmatched, ["GET /api/stats"])
  })
})
