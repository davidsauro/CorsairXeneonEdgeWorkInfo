require("../src/js/color.js");
const { check, done } = require("./harness");

console.log("\nQt normalised rgb (what iCUE actually stores)");
check("orange accent", Color.toCss("rgb(0.941176 0.556863 0.2)"), "#f08e33");
check("white text, which CSS would read as near-black", Color.toCss("rgb(1 1 1)"), "#ffffff");
check("black background", Color.toCss("rgb(0 0 0)"), "#000000");
check("purple accent", Color.toCss("rgb(0.603922 0.243137 0.815686)"), "#9a3ed0");

console.log("\nQt hsv, which CSS cannot parse at all");
check("hsv is converted", Color.toCss("hsv(0.681694 0.754467 0.941176)"), "#4b3bf0");
check("hsv with zero saturation is grey", Color.toCss("hsv(0 0 0.5)"), "#808080");
check("hsv full red", Color.toCss("hsv(0 1 1)"), "#ff0000");

console.log("\nordinary CSS forms pass through untouched");
check("6-digit hex", Color.toCss("#F1F3F4"), "#F1F3F4");
check("3-digit hex", Color.toCss("#abc"), "#abc");
check("8-digit hex is left for CSS to interpret", Color.toCss("#ff112233"), "#ff112233");
check("named colour", Color.toCss("rebeccapurple"), "rebeccapurple");
check("hsl is native to CSS", Color.toCss("hsl(210 50% 40%)"), "hsl(210 50% 40%)");

console.log("\n0-255 rgb is distinguished from normalised");
check("comma form", Color.toCss("rgb(240, 142, 51)"), "#f08e33");
check("space form above 1", Color.toCss("rgb(240 142 51)"), "#f08e33");
check("rgba drops the alpha", Color.toCss("rgba(240, 142, 51, 0.5)"), "#f08e33");
check("percentages", Color.toCss("rgb(100% 50% 0%)"), "#ff8000");

console.log("\nout-of-range and junk");
check("clamped, normalised branch", Color.toCss("rgb(0.5 -0.2 1)"), "#8000ff");
check("clamped, 0-255 branch", Color.toCss("rgb(300, -20, 128)"), "#ff0080");
// A component above 1 is what selects the 0-255 reading, so this is 2/255, not 100%.
check("ambiguous input follows the documented rule", Color.toCss("rgb(2 -1 0.5)"), "#020001");
check("empty string", Color.toCss(""), null);
check("null", Color.toCss(null), null);
check("undefined", Color.toCss(undefined), null);
check("too few components", Color.toCss("rgb(1 1)"), null);
check("non-numeric", Color.toCss("rgb(a b c)"), null);
check("nonsense", Color.toCss("!!!"), null);

done();
