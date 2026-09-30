import * as cdk from "aws-cdk-lib";
import { WorkbenchStack } from "./stack.js";

const app = new cdk.App();
new WorkbenchStack(app, "PAIDesignWorkbench", {
  env: { account: "820674626047", region: "ap-northeast-1" },
  description: "PAI design workbench in the existing WordPress VPC, authenticated shared HTTPS entry",
});
cdk.Tags.of(app).add("project", "pai-design-workbench");
