import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import cors from 'cors';
import { getDBProposal } from './utils/get-proposals';
import { submitProposal } from './utils/submit-proposal';
import { DiscordRequest } from './utils/discord';
import {
	MEGA_SUBMISSION_CONTRACT,
	baseUrl,
	forumChannelID,
} from './utils/constants';
import { getParameter } from './utils/get-parameter';
import { truncate } from './utils/truncate';
import cron from 'node-cron';
import { getAllDBProposal } from './utils/get-all-proposals';
import { getCurrentBlockHeight } from './utils/get-current-block-height';

dotenv.config();

const app: Express = express();
var urlencodedParser = bodyParser.urlencoded({ extended: false });
app.use(bodyParser.json());
app.use(cors());
const port = process.env.PORT || 3000;

app.get('/', (req: Request, res: Response) => {
	res.send('mega dao server');
});

cron.schedule('*/5 * * * *', async () => {
	console.log('updating tag...');
	try {
		const channel = await DiscordRequest(`channels/${forumChannelID}`, {
			method: 'GET',
		});
		console.log('cron job triggered at', Date.now());
		const proposals = await getAllDBProposal();
		if (!proposals) {
			console.log('no proposals in DB');
			return;
		}
		const validProposals = proposals.filter(
			(proposal: any) =>
				proposal.startBlockHeight &&
				proposal.endBlockHeight &&
				proposal.threadID,
		);

		validProposals.forEach(async (proposal: any) => {
			const currentBlockHeight = await getCurrentBlockHeight();
			const startBlockHeight = proposal.startBlockHeight;
			const endBlockHeight = proposal.endBlockHeight;

			const isClosed = currentBlockHeight > endBlockHeight;
			const isOpen =
				currentBlockHeight <= endBlockHeight &&
				currentBlockHeight >= startBlockHeight;
			const concluded = proposal.concluded;
			const tagName = concluded
				? 'Concluded'
				: isClosed
				? 'Ready to Execute'
				: isOpen
				? 'Live'
				: 'Pending';

			console.log(
				tagName,
				currentBlockHeight,
				startBlockHeight,
				endBlockHeight,
			);

			const tagIds: string[] = channel.available_tags.reduce(
				(acc: string[], tag: any) => {
					if (tag.name === 'Proposal' || tag.name === tagName) {
						acc.push(tag.id);
					}
					return acc;
				},
				[],
			);
			if (proposal.threadID) {
				await DiscordRequest(`channels/${proposal.threadID}`, {
					method: 'PATCH',
					body: {
						applied_tags: tagIds,
					},
				});
				console.log('tag updated');
			}
		});
	} catch (e: any) {
		console.error({ e });
		console.log('error updating tag');
	}
});

app.post(
	'/api/add-proposal',
	urlencodedParser,
	async function (req: Request, res: Response) {
		const submission = {
			contractAddress: MEGA_SUBMISSION_CONTRACT,
		};

		const events = await req.body;
		const channel = await DiscordRequest(`channels/${forumChannelID}`, {
			method: 'GET',
		});

		const tagIds: string[] = channel.available_tags.reduce(
			(acc: string[], tag: any) => {
				if (tag.name === 'Proposal' || tag.name === 'Pending') {
					acc.push(tag.id);
				}
				return acc;
			},
			[],
		);

		const proposalDuration: any = await getParameter(
			submission?.contractAddress,
			'proposalDuration',
		);
		const regex = /\(([^,]+)/;
		const start_height_regex = /u(\d+)\)/;

		console.log(tagIds, proposalDuration);

		events.apply.forEach((item: any) => {
			item.transactions.forEach(async (transaction: any) => {
				if (transaction.metadata.result.includes('true')) {
					console.log('transaction', transaction);
					const proposal: string =
						transaction.metadata.description.match(regex)[1];
					const startBlockHeight =
						transaction.metadata.description.match(
							start_height_regex,
						)[1];
					const endBlockHeight =
						Number(startBlockHeight) + Number(proposalDuration);

					const dbProposal = await getDBProposal(proposal);

					console.log(
						'dbProposal',
						dbProposal,
						proposal,
						startBlockHeight,
						endBlockHeight,
					);

					if (dbProposal && dbProposal.length > 0) {
						if (!dbProposal[0].submitted) {
							const new_thread = await DiscordRequest(
								`channels/${forumChannelID}/threads`,
								{
									method: 'POST',
									body: {
										name: `${
											proposal.split('.')[1]
										} proposal`,
										auto_archive_duration: 1440,
										message: {
											content: `Heads up! A fresh proposal has just landed.\n proposed by ${truncate(
												transaction.metadata.sender,
												5,
												5,
											)}\n proposal link: ${baseUrl}proposals/${proposal} \n\n **Title** : ${
												dbProposal[0].title
											}\n\n **Description** : ${
												dbProposal[0].description
											}`,
										},
										applied_tags: tagIds,
									},
								},
							);

							submitProposal({
								contractAddress: proposal,
								startBlockHeight,
								endBlockHeight,
								threadID: new_thread.id,
								submitted: true,
							});
						}
					}
				}
			});
		});
	},
);

app.listen(port, () => {
	console.log(`[server]: Server is running at http://localhost:${port}`);
});
