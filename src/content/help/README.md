# Help content

One file per route. Each file exports a `PageHelp` object matching
`src/lib/help/types.ts`. Import into the route component and pass to
`<HelpPanel help={pageHelp} />` at the top of the page.

Non-devs can edit these files without touching route code. Both `bn`
(বাংলা) and `en` (English) text are required for every string; the
`<LocaleSwitch>` in HelpPanel decides which to render at runtime.

To disable beginner-mode help across the whole app: flip
`DEFAULT_BEGINNER` in `src/lib/help/locale.ts` to `false`, or just leave
the toggle in the header — users can hide it themselves.
