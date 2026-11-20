import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const postcss=require(require.resolve('postcss',{paths:[require.resolve('vite')]}));
const root=new URL('../dist/client/assets/',import.meta.url);
const files=readdirSync(root);
// Parse imports: font URLs can contain semicolons inside quoted values.
// Removing up to the first semicolon corrupts the following :root rule.
const stylesheet=postcss.parse(readFileSync(new URL(files.find(f=>f.endsWith('.css')),root),'utf8'));
stylesheet.walkAtRules('import',rule=>rule.remove());
const css=stylesheet.toString();
const parsed=postcss.parse(css);
const theme=parsed.nodes.find(node=>node.type==='rule'&&node.selector.split(',').some(selector=>selector.trim()===':root'));
if(!theme?.nodes.some(node=>node.prop==='--dc-surface-raised'))throw new Error('Missing root design tokens in exported CSS');
const js=readFileSync(new URL(files.find(f=>f.endsWith('.js')),root),'utf8').replace(/<\/script/gi,'<\\/script');
const html=`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D-Contact — Agent Workspace Prototype</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
writeFileSync(new URL('../../d-contact-agent-workspace.html',import.meta.url),html);
console.log('Exported d-contact-agent-workspace.html — single HTML, bundled React/icons/logo, no required network access.');
