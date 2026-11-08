import { data } from "react-router";
import { ExpiredInvite } from "../ui";

export function loader() {
  return data(null, { status: 410 });
}

export default ExpiredInvite;
