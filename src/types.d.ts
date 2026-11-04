// Assets imported through Wrangler's Text rule (see "rules" in wrangler.jsonc).
declare module '*.yaml' {
  const content: string;
  export default content;
}
