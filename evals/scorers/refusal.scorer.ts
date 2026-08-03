const REFUSAL_PATTERNS = [
  /no permitted source/i,
  /i don'?t know/i,
  /couldn'?t find/i,
  /no information available/i,
  /cannot answer/i,
  /not in the provided context/i,
  /not in my knowledge/i,
  /no relevant information/i,
  /i don'?t have (that|this|enough) information/i,
  /i couldn'?t find anything about/i,
  /the context does not (contain|include|have)/i,
  /no context (was |)provided/i,
  /outside (of |)my knowledge/i,
  /not able to answer/i,
  /unable to answer/i,
  /suggest opening a support ticket/i,
  /you may want to open a support ticket/i,
];

export function isRefusal(output: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(output));
}
