// The renderer bundles src/art/*.txt as plain text (esbuild `--loader:.txt=text`).
declare module "*.txt" {
  const text: string;
  export default text;
}
