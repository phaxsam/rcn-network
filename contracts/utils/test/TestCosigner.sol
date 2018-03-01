pragma solidity ^0.4.15;

import "./../../interfaces/Cosigner.sol";
import "./../../utils/BytesUtils.sol";

import "./../../interfaces/Token.sol";

contract TestCosigner is Cosigner, BytesUtils {
    bytes32 public dummyCost = bytes32(uint256(1 * 10**18));
    bytes public data = buildData(keccak256("test_oracle"), dummyCost);
    bytes public badData = buildData(keccak256("bad_data"), dummyCost);

    Token public token;

    function TestCosigner(Token _token) public {
        token = _token;
    }

    function buildData(bytes32 a, bytes32 b) internal returns (bytes o) {
        assembly {
            let size := 64
            o := mload(0x40)
            mstore(0x40, add(o, and(add(add(size, 0x20), 0x1f), not(0x1f))))
            mstore(o, size)
            mstore(add(o, 32), a)
            mstore(add(o, 64), b)
        }
    }

    function getCost(address, uint256, bytes data) constant returns (uint256) {
        return uint256(readBytes32(data, 1));
    }

    function cosign(address engine, uint256, bytes data) returns (bool) {
        if(readBytes32(data, 0) == keccak256("test_oracle")) {
            require(token.transferFrom(engine, this, uint256(readBytes32(data, 1))));
            return true;
        } else {
            require(token.transferFrom(engine, this, uint256(readBytes32(data, 1))));
            return false;
        }
    }

    function url() constant returns (string) {
        return "";
    }

    function claim(address, uint256, bytes) public returns (bool) {
        return false;
    }
}