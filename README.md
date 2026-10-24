# usage-bars

A Claude Code mod that shows your plan's usage limits and the current context fill as progress bars under the prompt, right below the mode line.

```
⏵⏵ auto mode on (shift+tab to cycle)
Context ▇▇▇▇▇▇▇░░░░░░░░░░░░░░░░░  15%  155k/1.0M   Session ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇░░░░░░░░  62%  23:11
                                                  Weekly  ▇▇▇▇░░░░░░░░░░░░░░░░░░░░  18%  Thu 00:00
```

- **Context:** how full the context window is, as tokens used out of the window size. When you view a subagent's transcript, the bar shows that subagent's context instead.
- **Session:** the 5-hour usage window, with its reset time.
- **Weekly:** the 7-day usage window, with its reset day and time.
- The bars fill green, turn yellow at 70% and red at 90%, and use your theme's colours in light and dark mode.
- The bars stretch with the terminal width. Every other part has a fixed width, so the bars stay aligned.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-bars --marketplace <owner>/claude-code-usage-bars
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install usage-bars --marketplace <owner>/claude-code-usage-bars
```

In the desktop app, click **+** next to the prompt box, then **Plugins**. Choose **Add marketplace**, enter `<owner>/claude-code-usage-bars`, then choose **Add plugin**.

## Notes

- **Subscription only:** the usage limits come with a Pro or Max subscription. With an API key, only the context bar is shown.
- **When the bars update:** the figures come from the API's responses. Nothing shows until the session's first reply, and the bars update after each one. Usage from your other sessions shows up when this session gets its next response.
- **Resets:** once a window's reset time passes, its bar drops to 0% straight away, without waiting for the next response.
- **Subagent window size:** Claude Code only reports the window size for the main conversation. A subagent on the same model gets that size; one on a different model is assumed to have 200k.
- **Where it draws:** the terminal and the desktop app.

## Development

```
claude --plugin-dir .            # run a session with the mod loaded from this folder
claude plugin validate .         # check the manifest and hooks module
claude plugin test .             # run tests/*.test.tsx
```

- `hooks/register.tsx`: the hooks module.
- `types/index.d.ts`: the state contract.

When Claude Code loads the mod, it writes the API types to `.claude-plugin/types/`. After that, `tsc -p .` type-checks the mod.

## License

MIT
