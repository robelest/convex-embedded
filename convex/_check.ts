import { get } from "./dashboard";
import { bind } from "./issues";

type Check1 = typeof bind extends { isConvexFunction: true } ? "yes" : "no";
type Check2 = typeof get extends { isConvexFunction: true } ? "yes" : "no";

const _v1: "yes" = null! as Check1;
const _v2: "yes" = null! as Check2;
