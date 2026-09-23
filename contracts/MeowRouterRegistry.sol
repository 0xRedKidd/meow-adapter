// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MeowRouterRegistry
/// @notice Append-only record of every Meow router deployment on this chain.
///
/// The router is redeployed as execution improves, and every off-chain
/// consumer that tracks it (the DefiLlama dimension adapter, the subgraph,
/// dashboards) otherwise needs a code change and a review cycle per new
/// address. This registry gives them one stable address to read the full set
/// from: `routers()` at any block returns every router registered up to that
/// block, so a tracker that reads it at the end of its window and scans those
/// addresses' `Swapped` / `FeeCollected` logs sees complete history no matter
/// how often the router changes.
///
/// Entries are never removed. Retiring only stamps the block at which a router
/// stopped being served; its logs remain protocol history and trackers keep
/// counting them. Registering does not grant a contract anything: the registry
/// holds no funds and the routers do not consult it.
///
/// Block numbers are supplied by the owner and only checked for ordering. The
/// contract never reads `block.number`: on this Arbitrum-based chain it
/// returns the L1 block, which is unrelated to the L2 heights trackers use.
contract MeowRouterRegistry {
    /// @dev `abiVersion` names the event family a tracker must decode.
    ///      1 = HoodAggregator lineage:
    ///          Swapped(address indexed sender, address indexed recipient,
    ///                  address tokenIn, address tokenOut,
    ///                  uint256 amountIn, uint256 amountOut)
    ///          FeeCollected(address indexed token, address indexed recipient,
    ///                       uint256 amount)
    ///      Bump it only when a router changes those signatures.
    struct Router {
        address router;
        /// first block whose logs belong to this router (its deployment block)
        uint64 fromBlock;
        /// block at which the backend stopped serving it; 0 while current
        uint64 retiredBlock;
        uint32 abiVersion;
        string label;
    }

    uint32 public constant ABI_VERSION_HOOD_AGGREGATOR = 1;

    event RouterRegistered(
        address indexed router, uint64 fromBlock, uint64 retiredBlock, uint32 abiVersion, string label
    );
    event RouterRetired(address indexed router, uint64 retiredBlock);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error NotAContract(address router);
    error AlreadyRegistered(address router);
    error NotRegistered(address router);
    error AlreadyRetired(address router);
    error InvalidBlockRange();
    error InvalidAbiVersion();

    address public owner;
    address public pendingOwner;

    Router[] private _routers;
    /// @dev index + 1 into `_routers`; 0 means never registered.
    mapping(address => uint256) private _slot;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param seeds Routers that predate this registry, in deployment order.
    ///        Superseded ones carry their `retiredBlock` so history is complete
    ///        from the first deployment onward.
    constructor(Router[] memory seeds) {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
        for (uint256 i; i < seeds.length; ++i) {
            _register(seeds[i]);
        }
    }

    // ------------------------------------------------------------ mutators

    /// @notice Record a newly deployed router. `fromBlock` is its deployment
    ///         block; logs before it cannot exist, logs from it on count.
    function register(address router, uint64 fromBlock, uint32 abiVersion, string calldata label) external onlyOwner {
        _register(Router({router: router, fromBlock: fromBlock, retiredBlock: 0, abiVersion: abiVersion, label: label}));
    }

    /// @notice Mark a router as no longer served from `retiredBlock` (an L2
    ///         block at or after its `fromBlock`). It stays in `routers()`.
    function retire(address router, uint64 retiredBlock) external onlyOwner {
        uint256 slot = _slot[router];
        if (slot == 0) revert NotRegistered(router);
        Router storage r = _routers[slot - 1];
        if (r.retiredBlock != 0) revert AlreadyRetired(router);
        if (retiredBlock == 0 || retiredBlock < r.fromBlock) revert InvalidBlockRange();
        r.retiredBlock = retiredBlock;
        emit RouterRetired(router, retiredBlock);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // --------------------------------------------------------------- views

    /// @notice Every router ever registered, oldest first. This is the list a
    ///         tracker scans: it includes retired routers on purpose.
    function routers() external view returns (address[] memory list) {
        uint256 n = _routers.length;
        list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = _routers[i].router;
        }
    }

    /// @notice Routers currently served by the backend, oldest first.
    function activeRouters() external view returns (address[] memory list) {
        uint256 n = _routers.length;
        uint256 n_active;
        for (uint256 i; i < n; ++i) {
            if (_routers[i].retiredBlock == 0) ++n_active;
        }
        list = new address[](n_active);
        uint256 j;
        for (uint256 i; i < n; ++i) {
            if (_routers[i].retiredBlock == 0) list[j++] = _routers[i].router;
        }
    }

    /// @notice Full records, oldest first.
    function records() external view returns (Router[] memory) {
        return _routers;
    }

    function record(address router) external view returns (Router memory) {
        uint256 slot = _slot[router];
        if (slot == 0) revert NotRegistered(router);
        return _routers[slot - 1];
    }

    function isRegistered(address router) external view returns (bool) {
        return _slot[router] != 0;
    }

    function count() external view returns (uint256) {
        return _routers.length;
    }

    // ------------------------------------------------------------ internal

    function _register(Router memory r) private {
        if (r.router == address(0)) revert ZeroAddress();
        if (r.router.code.length == 0) revert NotAContract(r.router);
        if (_slot[r.router] != 0) revert AlreadyRegistered(r.router);
        if (r.abiVersion == 0) revert InvalidAbiVersion();
        // A router cannot be retired before it existed.
        if (r.fromBlock == 0 || (r.retiredBlock != 0 && r.retiredBlock < r.fromBlock)) revert InvalidBlockRange();
        _routers.push(r);
        _slot[r.router] = _routers.length;
        emit RouterRegistered(r.router, r.fromBlock, r.retiredBlock, r.abiVersion, r.label);
    }
}
