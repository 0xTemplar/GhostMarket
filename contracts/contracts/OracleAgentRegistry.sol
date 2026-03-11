// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OracleAgentRegistry
 * @notice Filecoin Calibration testnet registry for GhostMarket oracle agents.
 *
 * Each oracle agent is registered with a Filecoin Piece CID (from Synapse SDK upload).
 * Post-resolution, evidence bundles and reputation snapshots are recorded by CID.
 *
 * Filecoin bounty coverage:
 *  - Track 2 (Onchain Agent Registry): this contract is the registry
 *  - Track 3 (Portable Identity): reputation history is a CID chain on Filecoin
 *  - Track 4 (Autonomous Agent Economy): stake/slash under USDFC-gated storage costs
 */
contract OracleAgentRegistry is Ownable2Step, Pausable, ReentrancyGuard {

    // ── Data Structures ────────────────────────────────────────────────────

    struct Agent {
        address owner;
        string  metadataCID;      // Piece CID of agent metadata JSON on Filecoin
        uint256 stake;            // staked collateral (in wei)
        bool    active;
        uint256 reputationScore;  // 0–100
        uint256 correctVotes;
        uint256 totalVotes;
        uint256 erc8004Id;        // ERC-8004 identity token ID on Sepolia (0 = not linked)
    }

    // ── Storage ────────────────────────────────────────────────────────────

    mapping(uint256 => Agent)                              public agents;
    mapping(uint256 => string[])                           public reputationHistory;    // agentId → CID chain
    mapping(uint256 => mapping(uint256 => string))         public evidenceCIDs;         // agentId → marketId → CID
    mapping(uint256 => string)                             public slashCIDs;            // agentId → latest slash record CID
    mapping(uint256 => uint256[])                          public marketAgents;         // marketId → agentIds that attested
    mapping(uint256 => mapping(uint256 => bool))           public attestations;         // agentId → marketId → attested
    mapping(uint256 => mapping(uint256 => bool))           public votes;               // agentId → marketId → vote (YES=true)
    mapping(uint256 => bool)                               public marketFinalized;
    mapping(uint256 => bool)                               public marketOutcome;

    uint256 public agentCount;
    uint256 public constant INITIAL_REPUTATION = 80;
    uint256 public constant SLASH_PERCENT       = 10;
    uint256 public constant QUORUM_THRESHOLD    = 5;   // 5-of-7
    uint256 public constant MIN_AGENTS          = 7;

    // ── Events ─────────────────────────────────────────────────────────────

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        string  metadataCID,
        uint256 stake,
        uint256 erc8004Id
    );
    event ReputationUpdated(uint256 indexed agentId, string repCID, uint256 newScore);
    event EvidenceRecorded(uint256 indexed agentId, uint256 indexed marketId, string evidenceCID);
    event AttestationSubmitted(uint256 indexed agentId, uint256 indexed marketId, bool vote);
    event MarketFinalized(uint256 indexed marketId, bool outcome, uint256 yesVotes, uint256 noVotes, string evidenceBundleCID);
    event AgentSlashed(uint256 indexed agentId, uint256 slashAmount, string slashCID);
    event AgentSuspended(uint256 indexed agentId);
    event ERC8004Linked(uint256 indexed agentId, uint256 erc8004Id);

    // ── Constructor ────────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── Agent Lifecycle ────────────────────────────────────────────────────

    /**
     * @notice Register an oracle agent. Caller must have uploaded metadata JSON
     *         to Filecoin via Synapse SDK first; pass the returned Piece CID.
     */
    function register(
        uint256 agentId,
        string  calldata metadataCID,
        uint256 erc8004Id
    ) external payable whenNotPaused {
        require(agents[agentId].owner == address(0), "Agent ID taken");
        require(bytes(metadataCID).length > 0,        "Empty CID");

        agents[agentId] = Agent({
            owner:           msg.sender,
            metadataCID:     metadataCID,
            stake:           msg.value,
            active:          true,
            reputationScore: INITIAL_REPUTATION,
            correctVotes:    0,
            totalVotes:      0,
            erc8004Id:       erc8004Id
        });
        agentCount++;

        emit AgentRegistered(agentId, msg.sender, metadataCID, msg.value, erc8004Id);
    }

    /**
     * @notice Link an ERC-8004 identity token ID to an existing agent.
     */
    function linkERC8004(uint256 agentId, uint256 erc8004Id) external {
        require(agents[agentId].owner == msg.sender, "Not agent owner");
        agents[agentId].erc8004Id = erc8004Id;
        emit ERC8004Linked(agentId, erc8004Id);
    }

    // ── Oracle Attestation ─────────────────────────────────────────────────

    /**
     * @notice Submit an attestation for a market outcome.
     *         intermediateEvidenceCID is a Storacha CID written during collection.
     */
    function submitAttestation(
        uint256 agentId,
        uint256 marketId,
        bool    vote,
        string  calldata intermediateEvidenceCID
    ) external {
        Agent storage agent = agents[agentId];
        require(agent.owner != address(0),   "Agent not found");
        require(agent.active,                "Agent suspended");
        require(msg.sender == agent.owner || msg.sender == owner(), "Not authorized");
        require(!attestations[agentId][marketId], "Already attested");
        require(!marketFinalized[marketId],        "Market finalized");

        attestations[agentId][marketId] = true;
        votes[agentId][marketId]        = vote;
        marketAgents[marketId].push(agentId);

        agent.totalVotes++;

        // Store intermediate Storacha CID
        if (bytes(intermediateEvidenceCID).length > 0) {
            evidenceCIDs[agentId][marketId] = intermediateEvidenceCID;
        }

        emit AttestationSubmitted(agentId, marketId, vote);

        _tryFinalize(marketId);
    }

    // ── Evidence and Reputation ────────────────────────────────────────────

    /**
     * @notice Record finalized evidence bundle CID (from Synapse SDK upload).
     *         Called after quorum is reached and bundle is uploaded to Filecoin.
     */
    function recordEvidence(
        uint256 agentId,
        uint256 marketId,
        string  calldata evidenceCID
    ) external {
        require(
            msg.sender == agents[agentId].owner || msg.sender == owner(),
            "Not authorized"
        );
        evidenceCIDs[agentId][marketId] = evidenceCID;
        emit EvidenceRecorded(agentId, marketId, evidenceCID);
    }

    /**
     * @notice Update reputation after resolution; upload repCID via Synapse first.
     */
    function updateReputation(
        uint256 agentId,
        string  calldata repCID,
        uint256 newScore
    ) external onlyOwner {
        require(agents[agentId].owner != address(0), "Agent not found");
        require(newScore <= 100, "Score out of range");

        agents[agentId].reputationScore = newScore;
        reputationHistory[agentId].push(repCID);

        emit ReputationUpdated(agentId, repCID, newScore);
    }

    // ── Slashing ───────────────────────────────────────────────────────────

    /**
     * @notice Slash an agent for incorrect final-side vote.
     *         slashCID is the Filecoin Piece CID of the slash record.
     */
    function slash(uint256 agentId, string calldata slashCID) external onlyOwner nonReentrant {
        Agent storage agent = agents[agentId];
        require(agent.owner != address(0), "Agent not found");

        uint256 slashAmount  = (agent.stake * SLASH_PERCENT) / 100;
        agent.stake         -= slashAmount;
        slashCIDs[agentId]   = slashCID;

        if (agent.reputationScore >= 10) {
            agent.reputationScore -= 10;
        } else {
            agent.reputationScore = 0;
        }

        emit AgentSlashed(agentId, slashAmount, slashCID);
    }

    function suspend(uint256 agentId) external onlyOwner {
        agents[agentId].active = false;
        emit AgentSuspended(agentId);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function getReputationHistory(uint256 agentId) external view returns (string[] memory) {
        return reputationHistory[agentId];
    }

    function getMarketAttesters(uint256 marketId) external view returns (uint256[] memory) {
        return marketAgents[marketId];
    }

    function getAgentInfo(uint256 agentId) external view returns (
        address  owner,
        string   memory metadataCID,
        uint256  stake,
        bool     active,
        uint256  reputationScore,
        uint256  correctVotes,
        uint256  totalVotes,
        uint256  erc8004Id
    ) {
        Agent storage a = agents[agentId];
        return (
            a.owner,
            a.metadataCID,
            a.stake,
            a.active,
            a.reputationScore,
            a.correctVotes,
            a.totalVotes,
            a.erc8004Id
        );
    }

    function getQuorumStatus(uint256 marketId) external view returns (
        uint256 totalAttestations,
        uint256 yesVotes,
        uint256 noVotes,
        bool    quorumReached,
        bool    finalized,
        bool    outcome
    ) {
        uint256[] storage attesters = marketAgents[marketId];
        uint256 yes;
        uint256 no;
        for (uint256 i = 0; i < attesters.length; i++) {
            if (votes[attesters[i]][marketId]) {
                yes++;
            } else {
                no++;
            }
        }
        return (
            attesters.length,
            yes,
            no,
            (yes >= QUORUM_THRESHOLD || no >= QUORUM_THRESHOLD),
            marketFinalized[marketId],
            marketOutcome[marketId]
        );
    }

    // ── Internal ───────────────────────────────────────────────────────────

    function _tryFinalize(uint256 marketId) internal {
        if (marketFinalized[marketId]) return;

        uint256[] storage attesters = marketAgents[marketId];
        uint256 yes;
        uint256 no;

        for (uint256 i = 0; i < attesters.length; i++) {
            if (votes[attesters[i]][marketId]) {
                yes++;
            } else {
                no++;
            }
        }

        bool outcome;
        bool reached;

        if (yes >= QUORUM_THRESHOLD) {
            outcome = true;
            reached = true;
        } else if (no >= QUORUM_THRESHOLD) {
            outcome = false;
            reached = true;
        }

        if (!reached) return;

        marketFinalized[marketId] = true;
        marketOutcome[marketId]   = outcome;

        // Update correctVotes for agents on the winning side
        for (uint256 i = 0; i < attesters.length; i++) {
            if (votes[attesters[i]][marketId] == outcome) {
                agents[attesters[i]].correctVotes++;
            }
        }

        emit MarketFinalized(marketId, outcome, yes, no, "");
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function pause()   external onlyOwner { _pause();   }
    function unpause() external onlyOwner { _unpause(); }

    receive() external payable {}

    function withdrawSlashedStake(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(address(this).balance >= amount, "Insufficient balance");
        to.transfer(amount);
    }
}
