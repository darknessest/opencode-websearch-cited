export default {
	"*.{js,jsx,ts,tsx,json,yml,yaml,css,graphql,html}": ["biome check --write --staged --no-errors-on-unmatched"],
	"*.{ts,tsx}": () => "tsgo -p tsconfig.json",
};
