import { defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UiRequestHost } from "@earendil-works/pi-coding-agent/experimental/plugin";

/**
 * Asks the person three questions when the Session worker starts, to show the extension question
 * contract end to end: a choice, a yes/no, and a line of text. Each answer is reported back through
 * a notice and a status line, and a question nobody answers times out instead of blocking.
 */
export default defineFacet({
	id: "@earendil-works/pi-example-questions/session",
	setup(env) {
		const ui = env.use(UiRequestHost);
		env.onActivate(() => {
			void (async () => {
				const flavor = await ui.select(
					"Pick a flavor",
					[
						{ value: "mint", label: "Mint", description: "cool and sharp" },
						{ value: "vanilla", label: "Vanilla", description: "plain and sweet" },
						{ value: "pepper", label: "Pepper" },
					],
					{ message: "The example extension is asking." },
					BACKGROUND_CONTEXT,
				);
				ui.notify("info", flavor === undefined ? "No flavor was picked." : `You picked ${flavor}.`);
				const keepGoing = await ui.confirm("Keep going?", { message: "Answer yes or no." }, BACKGROUND_CONTEXT);
				ui.notify("info", keepGoing === undefined ? "No answer to keep going." : `Keep going: ${keepGoing}.`);
				const name = await ui.input(
					"What should it be called?",
					{ placeholder: "a name", defaultValue: "pipsqueak" },
					BACKGROUND_CONTEXT,
				);
				ui.notify("info", name === undefined ? "No name was given." : `Called ${name}.`);
				ui.setStatus("example-questions", `flavor ${flavor ?? "none"}`);
			})();
		});
	},
});
