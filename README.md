# pi-featherless

[Featherless.ai](https://featherless.ai) provider for [Pi](https://pi.dev)

## Install

```bash
pi install git:github.com/wsehl/pi-featherless
```

Try it without installing:

```bash
pi -e git:github.com/wsehl/pi-featherless
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
- Models are registered as text-only and without thinking support, because the Featherless
  catalog does not report tool or reasoning capabilities. Small models handle pi's tools poorly.
- Featherless context-overflow errors are normalised so pi can compact and retry.

## Development

```bash
pnpm install
pnpm check      # oxlint, oxfmt, tsc
pi -ne -e .     # run pi with only this extension
```
