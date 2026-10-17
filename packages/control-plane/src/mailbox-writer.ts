/**
 * The control plane's one way to write a mailbox message (MBX1). Every site
 * used to build the document by hand and re-implement its shape (`id`,
 * `timestamp`, `readBy`); one of them
 * had already drifted (a missing `timestamp` that the daemon then had to
 * tolerate). Delegating to the daemon's own repository keeps a single
 * definition of what a mailbox document is. Tripwire T12 fails any new raw
 * insert in either package.
 */

import {
	createMongoMailboxRepository,
	type MailboxMessage,
} from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";

export type MailboxPost = Pick<
	MailboxMessage,
	"missionId" | "from" | "to" | "subject" | "body"
>;

export async function postMailbox(
	db: Db,
	msg: MailboxPost,
): Promise<MailboxMessage> {
	return createMongoMailboxRepository(db, msg.missionId).post({
		...msg,
		to: [...new Set(msg.to)],
	});
}
