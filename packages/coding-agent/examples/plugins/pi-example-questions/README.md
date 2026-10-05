# `@earendil-works/pi-example-questions`

A Session-worker facet that asks the person three questions through the `UiRequestHost`: a choice, a yes/no, and a line of text. It reports each answer as a notice and sets a status line. A desktop presentation shows the questions as dialogs; an unanswered question is cancelled after its timeout.

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server \
  -e "$PWD/packages/coding-agent/examples/plugins/pi-example-questions"
```

See `UiRequests` and `UiRequestHost` in `src/experimental/services/ui-requests.ts`.
