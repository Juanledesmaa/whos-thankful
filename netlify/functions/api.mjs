import { getStore } from "@netlify/blobs";
import { handleAction } from "../../server/game.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  // Strong consistency: a phone must see its own answer on the very next poll.
  const store = getStore({ name: "guess-whos-thankful", consistency: "strong" });
  const { status, data } = await handleAction(store, body);
  return json(data, status);
};

export const config = { path: "/api" };
