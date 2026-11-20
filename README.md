# Guess Who's Thankful

A Thanksgiving game for a group. Everyone writes what they're thankful for on their phone. The big screen shows one answer at a time and the room guesses who wrote it.

## How a night runs

1. Open the site on the projector or TV and press **Host a new game**.
2. Players scan the QR code (or type the 4-letter room code) and enter their first name.
3. Pick tonight's question and press **Start writing**. Everyone answers on their phone.
4. Press **Start guessing**. For each answer: the room votes, you press **Reveal who wrote it**, then **Next answer**.
5. **End the game** whenever you like. The final screen shows the podium and every answer with its author.

Scoring: right guesses score by speed. The fastest right guess earns 100, the slowest 50, the rest in between. Changing your guess counts as a new, later guess. The writer earns up to 100 for stumping the room. Scores add up across all answers and the final screen shows the totals.

Host controls:

- **Reset game** (top right) goes back to the lobby from any point. Answers and scores are cleared, players stay in the room.
- **Play again and keep scores** on the final screen starts a new question with the running totals.
- **Skip this answer** hides an answer without revealing the author.
- The × on a name removes a player (before guessing starts).

Keep the host tab open on the same browser; refreshing it is fine. Leave the question blank to use the default one.

## Deploy to Netlify

The game needs Netlify Functions and Netlify Blobs, so drag-and-drop upload won't work. Use the CLI:

```bash
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

The first deploy asks you to create a new site. No build command; the publish folder is `public` (already set in `netlify.toml`). No environment variables or extra accounts.

Or push this folder to GitHub and import the repo in the Netlify dashboard. The settings come from `netlify.toml`.

## Run it locally

```bash
npm run local
```

Opens on http://localhost:8888 with rooms kept in memory (no Netlify needed). Use `npx netlify-cli dev` to run against the real Functions and Blobs setup.

## Files

- `public/` the page, styles, and browser code
- `server/game.mjs` the game rules
- `netlify/functions/api.mjs` the `/api` endpoint, storing rooms in Netlify Blobs
- `dev-server.mjs` the local test server
