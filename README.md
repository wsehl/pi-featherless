# pi-featherless

[Featherless.ai](https://featherless.ai) provider for Pi coding agent.

## Install

```bash
pi install npm:@wsehl/pi-featherless
```

Try it without installing:

```bash
pi -e npm:@wsehl/pi-featherless
```

## Set up

Run `/login featherless` and paste your API key. Pi stores it in `~/.pi/agent/auth.json`.  
You can set `FEATHERLESS_API_KEY` instead. A stored key takes priority.

The model list downloads in the background when a session starts.
In a new install, run `/reload` after logging in. Then:

```bash
pi --model featherless/Qwen/Qwen2.5-7B-Instruct
```

## Notes

- The catalog is cached in `models-store.json` and refreshed at most every 6 hours.
  Startup does not wait for the network. Set `PI_OFFLINE=1` to skip refreshes.
- Image input follows the catalog's `image_input` flag. Qwen3-family models get thinking support,
  and pi's thinking level toggles it through `chat_template_kwargs.enable_thinking`. At level
  `off` they answer without thinking. Other models are registered without thinking support.
  Small models handle pi's tools poorly.
- `max_tokens` is left out of requests, so Featherless allows whatever context remains. Pi's own
  estimate counts old thinking that the server drops, and after compaction it could cap replies
  at a few tokens.
- Featherless context-overflow errors are normalised so pi can compact and retry.

## Development

```bash
pnpm install
pnpm check      # oxlint, oxfmt, tsc
pi -ne -e .     # run pi with only this extension
```
