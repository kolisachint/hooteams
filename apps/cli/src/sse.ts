/** Connect to a bridge SSE endpoint and invoke onEvent per parsed frame. */
export async function consumeSSE(
	url: string,
	onEvent: (event: any) => void,
	signal?: AbortSignal,
): Promise<void> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) {
		throw new Error(`Failed to connect to ${url}: HTTP ${response.status}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			let index: number;
			while ((index = text.indexOf("\n\n")) !== -1) {
				const frame = text.slice(0, index);
				text = text.slice(index + 2);
				if (frame.startsWith("data: ")) {
					onEvent(JSON.parse(frame.slice("data: ".length)));
				}
			}
		}
	} catch (error) {
		if (!signal?.aborted) throw error;
	}
}
