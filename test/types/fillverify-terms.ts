// Compile-only fixture for test/fillverify-types.test.mjs; it is type-checked, never run.
import { bindOfferTerms, type OfferFillCheck } from "../../src/index.js";

declare const check: OfferFillCheck;
declare const served: unknown;

// A dApp passes the verdict's terms back to the default call (give and wantType legs on). That compiles
// only while `OfferFillCheck.terms` keeps cairnx-core's mint brand.
if (check.terms) bindOfferTerms(served, check.terms);

// Hand-built terms need the explicit opt-out through the SDK's re-export, as in cairnx-core.
const handBuilt = { height: 40000, feeBps: 150, value: "500000000" };
// @ts-expect-error unminted terms with the give and wantType legs on
bindOfferTerms(served, handBuilt);
bindOfferTerms(served, handBuilt, { give: false, wantType: false });
