import { makeStoredPublishKit } from '@agoric/notifier';
import { makeScalarMapStore, makeExo, M } from '@agoric/store';
import { natSafeMath } from '@agoric/zoe/src/contractSupport/index.js';
import { E } from '@endo/eventual-send';

import { EmptyProposalShape } from '@agoric/zoe/src/typeGuards.js';
import { makeHandle } from '@agoric/zoe/src/makeHandle.js';
import {
  getOpenQuestions,
  getPoserInvitation,
  getQuestion,
  startCounter,
} from './electorateTools.js';
import { QuorumRule } from './question.js';
import {
  QuestionHandleShape,
  PositionShape,
  ElectorateCreatorI,
  ElectoratePublicI,
} from './typeGuards.js';

const { ceilDivide } = natSafeMath;

/**
 * @typedef { ElectorateCreatorFacet & {
 *   getVoterInvitations: () => Promise<Invitation<{ voter: { castBallotFor(handle: any, choice?: any, ): void}}>>[]
 * }} CommitteeElectorateCreatorFacet
 */

/**
 * Each Committee (an Electorate) represents a particular set of voters. The
 * number of voters is visible in the terms.
 *
 * This contract creates an electorate whose membership is not visible to
 * observers. There may be uses for such a structure, but it is not appropriate
 * for elections where the set of voters needs to be known, unless the contract
 * is used in a way that makes the distribution of voter facets visible.
 *
 * @param {ZCF<{
 *   committeeName: string,
 *   committeeSize: number,
 * }>} zcf
 * @param {{ storageNode: ERef<StorageNode>, marshaller: ERef<Marshaller>}} privateArgs
 * @returns {{creatorFacet: CommitteeElectorateCreatorFacet, publicFacet: CommitteeElectoratePublic}}
 */
const start = (zcf, privateArgs) => {
  /** @type {MapStore<Handle<'Question'>, import('./electorateTools.js').QuestionRecord>} */
  const allQuestions = makeScalarMapStore('Question');
  assert(privateArgs?.storageNode, 'Missing storageNode');
  assert(privateArgs?.marshaller, 'Missing marshaller');
  const questionNode = E(privateArgs.storageNode).makeChildNode(
    'latestQuestion',
  );
  /** @type {StoredPublishKit<QuestionDetails>} */
  const { subscriber: questionsSubscriber, publisher: questionsPublisher } =
    makeStoredPublishKit(questionNode, privateArgs.marshaller);

  const makeCommitteeVoterInvitation = index => {
    /** @type {OfferHandler} */
    const offerHandler = seat => {
      const voterHandle = makeHandle('Voter');
      seat.exit();

      const VoterI = M.interface('voter', {
        castBallotFor: M.call(
          QuestionHandleShape,
          M.arrayOf(PositionShape),
        ).returns(M.promise()),
      });
      const InvitationMakerI = M.interface('invitationMaker', {
        makeVoteInvitation: M.call(
          M.arrayOf(PositionShape),
          QuestionHandleShape,
        ).returns(M.promise()),
      });

      // CRUCIAL: voteCap carries the ability to cast votes for any voter at
      // any weight. It's wrapped here and given to the voter.
      //
      // Ensure that the voter can't get access to the unwrapped voteCap, and
      // has no control over the voteHandle or weight
      return harden({
        voter: makeExo(`voter${index}`, VoterI, {
          castBallotFor(questionHandle, positions) {
            const { voteCap } = allQuestions.get(questionHandle);
            return E(voteCap).submitVote(voterHandle, positions, 1n);
          },
        }),
        invitationMakers: makeExo('invitation makers', InvitationMakerI, {
          makeVoteInvitation(positions, questionHandle) {
            const continuingVoteHandler = cSeat => {
              cSeat.exit();
              const { voteCap } = allQuestions.get(questionHandle);
              return E(voteCap).submitVote(voterHandle, positions, 1n);
            };

            return zcf.makeInvitation(
              continuingVoteHandler,
              'vote',
              undefined,
              EmptyProposalShape,
            );
          },
        }),
      });
    };

    // https://github.com/Agoric/agoric-sdk/pull/3448/files#r704003612
    // This will produce unique descriptions because
    // makeCommitteeVoterInvitation() is only called within the following loop,
    // which is only called once per Electorate.
    return zcf.makeInvitation(
      offerHandler,
      `Voter${index}`,
      undefined,
      EmptyProposalShape,
    );
  };

  const { committeeName, committeeSize } = zcf.getTerms();

  const invitations = harden(
    [...Array(committeeSize).keys()].map(makeCommitteeVoterInvitation),
  );

  const publicFacet = makeExo('Committee publicFacet', ElectoratePublicI, {
    getQuestionSubscriber() {
      return questionsSubscriber;
    },
    getOpenQuestions() {
      return getOpenQuestions(allQuestions);
    },
    getName() {
      return committeeName;
    },
    getInstance() {
      return zcf.getInstance();
    },
    getQuestion(handleP) {
      return getQuestion(handleP, allQuestions);
    },
  });

  const creatorFacet = makeExo('Committee creatorFacet', ElectorateCreatorI, {
    getPoserInvitation() {
      return getPoserInvitation(zcf, async (voteCounter, questionSpec) =>
        creatorFacet.addQuestion(voteCounter, questionSpec),
      );
    },
    /** @type {AddQuestion} */
    async addQuestion(voteCounter, questionSpec) {
      const quorumThreshold = quorumRule => {
        switch (quorumRule) {
          case QuorumRule.MAJORITY:
            return ceilDivide(committeeSize, 2);
          case QuorumRule.ALL:
            return committeeSize;
          case QuorumRule.NO_QUORUM:
            return 0;
          default:
            throw Error(`${quorumRule} is not a recognized quorum rule`);
        }
      };

      const outcomeNode = E(privateArgs.storageNode).makeChildNode(
        'latestOutcome',
      );

      /** @type {StoredPublishKit<OutcomeRecord>} */
      const { publisher: outcomePublisher } = makeStoredPublishKit(
        outcomeNode,
        privateArgs.marshaller,
      );

      return startCounter(
        zcf,
        questionSpec,
        quorumThreshold(questionSpec.quorumRule),
        voteCounter,
        allQuestions,
        questionsPublisher,
        outcomePublisher,
      );
    },
    getVoterInvitations() {
      return invitations;
    },
    getQuestionSubscriber() {
      return questionsSubscriber;
    },

    getPublicFacet() {
      return publicFacet;
    },
  });

  return { publicFacet, creatorFacet };
};

harden(start);
export { start };
