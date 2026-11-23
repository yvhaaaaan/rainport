// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Credits is ERC20 {
    constructor(address[] memory drivers) ERC20("Rainport Credits","CR") {
        for(uint i=0;i<drivers.length;i++) _mint(drivers[i],10000);
    }
    function decimals() public pure override returns(uint8){return 0;}
}
interface IRandom {function word(bytes32 race,address driver) external view returns(uint);}
contract LocalMockRandom is IRandom {
    function word(bytes32 r,address d) external view returns(uint){
        return uint(keccak256(abi.encode("LOCAL_MOCK_V1",block.chainid,r,d)));
    }
}
contract Archive is ERC721, ReentrancyGuard {
    Credits public immutable credits;
    address public immutable referee;
    address public immutable treasury;
    IRandom public source;
    uint public tokenCount; uint public orderCount; bool public genesisClosed;
    struct Asset {uint8 model;uint8 edition;uint mount;uint lockId;uint[3] parts;bytes32 origin;address first;uint8 originRank;}
    mapping(uint=>Asset) private items;
    enum Kind {None,Model,Serial,Car,Bid}
    enum Status {None,Open,Sold,Cancelled,Expired}
    struct Order {Kind kind;Status status;address maker;address buyer;uint key;uint price;uint paid;uint expiry;uint soldAt;uint linked;uint[4] ids;}
    mapping(uint=>Order) private orders;
    struct Race {uint8 stage;uint8 rank;uint16 odds;uint16 pool;uint totalMs;uint prize;uint startTime;uint[4] config;bytes32 configHash;bytes32 summary;bytes32 replay;IRandom rng;}
    mapping(bytes32=>Race) private races;
    mapping(uint=>uint) public busyUntil;
    mapping(uint=>bytes32) private active;
    event Opened(uint indexed id,address indexed maker,Kind kind,uint price,uint[4] ids);
    event Filled(uint indexed id,address indexed seller,address indexed buyer,uint price,uint fee,uint[4] ids);
    event Closed(uint indexed id,Status status);
    event Fitted(uint indexed car,uint indexed part,uint slot,uint old);
    event Grid(bytes32 indexed race,address indexed driver,uint[4] config,bytes32 configHash,uint oddsVersion,uint poolVersion);
    event Classified(bytes32 indexed race,address indexed driver,uint rank,uint totalMs,bytes32 summary,bytes32 replay);
    event Reward(bytes32 indexed race,address indexed driver,uint tier,uint token);
    constructor(Credits token,address fees,IRandom rng) ERC721("Curve Archive","ARC") {
        credits=token;referee=msg.sender;treasury=fees;source=rng;
    }
    modifier official(){require(msg.sender==referee,"RefereeOnly");_;}
    function setRandomSource(IRandom rng) external official {require(address(rng).code.length!=0);source=rng;}
    function asset(uint t) external view returns(Asset memory){ownerOf(t);return items[t];}
    function order(uint o) external view returns(Order memory){return orders[o];}
    function entry(bytes32 r,address d) public pure returns(bytes32){return keccak256(abi.encode(r,d));}
    function race(bytes32 r,address d) external view returns(Race memory){return races[entry(r,d)];}
    function _issue(address who,uint8 m,uint8 e,bytes32 r,uint8 rank) internal returns(uint t){
        t=++tokenCount;Asset storage a=items[t];a.model=m;a.edition=e;a.origin=r;a.first=who;a.originRank=rank;_mint(who,t);
    }
    function seed(address who,uint8 m,uint8 e) external official returns(uint){require(!genesisClosed&&m<=6&&e<4);return _issue(who,m,e,0,0);}
    function seal() external official {genesisClosed=true;}
    function _free(uint t) internal view {
        Asset storage a=items[t];
        require(a.lockId==0,"AssetListed");require(a.mount==0,"PartMounted");require(busyUntil[t]<=block.timestamp,"CarRacing");
        require(a.parts[0]==0&&a.parts[1]==0&&a.parts[2]==0,"CarAssembled");
    }
    function _update(address to,uint t,address auth) internal override returns(address){
        if(_ownerOf(t)!=address(0)) _free(t);
        return super._update(to,t,auth);
    }
    function fit(uint c,uint s,uint t) external {
        Asset storage car=items[c];require(ownerOf(c)==msg.sender&&car.model==0&&s<3,"NotYourChassis");
        require(car.lockId==0,"CarListed");require(busyUntil[c]<=block.timestamp,"CarRacing");
        if(t!=0){require(ownerOf(t)==msg.sender&&items[t].model>0&&(items[t].model-1)/2==s,"IncompatiblePart");_free(t);}
        uint old=car.parts[s];if(old!=0)items[old].mount=0;car.parts[s]=t;if(t!=0)items[t].mount=c;
        emit Fitted(c,t,s,old);
    }
    function _key(uint t) internal view returns(uint){return uint(items[t].model)*4+items[t].edition;}
    function _new(Kind k,uint key,uint price,uint expiry) internal returns(uint id){
        require(price>0&&price<=1e9,"InvalidPrice");
        require(expiry>block.timestamp&&expiry<=block.timestamp+30 days,"InvalidExpiry");
        id=++orderCount;Order storage o=orders[id];o.kind=k;o.key=key;o.status=Status.Open;o.maker=msg.sender;o.price=price;o.expiry=expiry;
    }
    function best(Kind k,uint key,uint limit,address actor) public view returns(uint id){
        for(uint i=1;i<=orderCount;i++){
            Order storage o=orders[i];
            if(o.kind!=k||o.key!=key||o.status!=Status.Open||o.expiry<=block.timestamp||o.maker==actor)continue;
            if((k==Kind.Model&&o.price<=limit&&(id==0||o.price<orders[id].price))||
               (k==Kind.Bid&&o.price>=limit&&(id==0||o.price>orders[id].price)))id=i;
        }
    }
    function list(Kind k,uint t,uint price,uint expiry) external nonReentrant returns(uint id){
        require(ownerOf(t)==msg.sender,"NotOwner");Asset storage a=items[t];
        if(k==Kind.Car){require(a.model==0&&a.lockId==0&&busyUntil[t]<=block.timestamp,"CarUnavailable");}
        else {require((k==Kind.Model||k==Kind.Serial)&&a.model>0,"PartOnly");_free(t);}
        id=_new(k,_key(t),price,expiry);Order storage o=orders[id];o.ids[0]=t;a.lockId=id;
        if(k==Kind.Car)for(uint i=0;i<3;i++){
            uint p=a.parts[i];require(p!=0&&ownerOf(p)==msg.sender&&items[p].lockId==0&&items[p].mount==t,"IncompleteCar");
            items[p].lockId=id;o.ids[i+1]=p;
        }
        emit Opened(id,msg.sender,k,price,o.ids);
        if(k==Kind.Model){uint bid=best(Kind.Bid,o.key,price,msg.sender);if(bid!=0)_match(id,bid,orders[bid].price);}
    }
    function bid(uint key,uint price,uint expiry) external nonReentrant returns(uint id){
        require(key>=4&&key<28,"UnknownSpec");id=_new(Kind.Bid,key,price,expiry);
        require(credits.transferFrom(msg.sender,address(this),price));
        emit Opened(id,msg.sender,Kind.Bid,price,orders[id].ids);
        uint ask=best(Kind.Model,key,price,msg.sender);if(ask!=0)_match(ask,id,orders[ask].price);
    }
    function _match(uint ask,uint bidId,uint price) internal {
        Order storage b=orders[bidId];b.status=Status.Sold;b.ids[0]=orders[ask].ids[0];b.buyer=b.maker;b.paid=price;b.soldAt=block.timestamp;
        b.linked=ask;orders[ask].linked=bidId;
        _deliver(ask,b.maker,true,price);
        if(b.price>price)require(credits.transfer(b.maker,b.price-price));
    }
    function _pay(address buyer,address to,bool escrow,uint amount) internal {
        if(amount==0)return;
        require(escrow?credits.transfer(to,amount):credits.transferFrom(buyer,to,amount),"PaymentFailed");
    }
    function _deliver(uint id,address buyer,bool escrow,uint price) internal{
        Order storage o=orders[id];require(o.status==Status.Open&&o.expiry>block.timestamp,"OrderClosed");
        require(o.kind!=Kind.Bid&&buyer!=o.maker,"WrongBuyer");
        o.status=Status.Sold;o.buyer=buyer;o.paid=price;o.soldAt=block.timestamp;
        uint fee=price*2/100;_pay(buyer,o.maker,escrow,price-fee);_pay(buyer,treasury,escrow,fee);
        for(uint i=0;i<(o.kind==Kind.Car?4:1);i++){
            uint t=o.ids[i];require(items[t].lockId==id&&ownerOf(t)==o.maker,"DeliveryChanged");
            items[t].lockId=0;
            // Only this atomic bundle path may move mounted NFTs. No receiver callbacks intervene.
            super._update(buyer,t,address(0));
        }
        emit Filled(id,o.maker,buyer,price,fee,o.ids);
    }
    function buy(uint id,uint expectedPrice) external nonReentrant{
        Order storage o=orders[id];require(o.price==expectedPrice,"PriceChanged");
        if(o.kind==Kind.Model)require(best(Kind.Model,o.key,o.price,msg.sender)==id,"BetterAskExists");
        _deliver(id,msg.sender,false,o.price);
    }
    function close(uint id) external nonReentrant{
        Order storage o=orders[id];require(o.status==Status.Open,"OrderClosed");
        bool expired=o.expiry<=block.timestamp;require(expired||o.maker==msg.sender,"NotYourOrder");
        o.status=expired?Status.Expired:Status.Cancelled;
        if(o.kind==Kind.Bid)require(credits.transfer(o.maker,o.price));
        else for(uint i=0;i<(o.kind==Kind.Car?4:1);i++)items[o.ids[i]].lockId=0;
        emit Closed(id,o.status);
    }
    function start(bytes32 r,address d,uint car) external official{
        bytes32 k=entry(r,d);Race storage g=races[k];require(g.stage==0&&d!=address(0),"AlreadyStarted");
        g.stage=1;g.startTime=block.timestamp;g.odds=1;g.pool=1;g.rng=source;
        if(car!=0){
            require(ownerOf(car)==d&&items[car].model==0&&items[car].lockId==0&&busyUntil[car]<=block.timestamp,"CarUnavailable");
            g.config[0]=car;
            for(uint i=0;i<3;i++){uint p=items[car].parts[i];require(p!=0&&items[p].lockId==0,"IncompleteCar");g.config[i+1]=p;}
            busyUntil[car]=block.timestamp+300;active[car]=k;
        }
        g.configHash=keccak256(abi.encode(g.config,g.odds,g.pool));emit Grid(r,d,g.config,g.configHash,1,1);
    }
    function abandon(bytes32 r,address d) external official {
        bytes32 k=entry(r,d);Race storage g=races[k];require(g.stage==1);g.stage=4;
        if(active[g.config[0]]==k)busyUntil[g.config[0]]=0;
    }
    function confirm(bytes32 r,address d,uint8 rank,uint ms,bytes32 summary,bytes32 replay) external official{
        bytes32 k=entry(r,d);Race storage g=races[k];
        require(g.stage==1&&rank>=1&&rank<=8&&ms>0&&ms<=240000,"InvalidResult");
        require(block.timestamp<=g.startTime+300&&block.timestamp+2>=g.startTime+ms/1000,"InvalidClock");
        g.stage=2;g.rank=rank;g.totalMs=ms;g.summary=summary;g.replay=replay;
        if(active[g.config[0]]==k)busyUntil[g.config[0]]=0;
        emit Classified(r,d,rank,ms,summary,replay);
    }
    function tier(uint rank,uint roll) public pure returns(uint8){
        require(rank>0&&rank<=8&&roll<10000);
        if(rank==1)return roll<2000?1:roll<7000?2:roll<9850?3:4;
        if(rank<=3)return roll<1000?0:roll<5500?1:roll<8900?2:roll<9950?3:4;
        if(rank<=5)return roll<3000?0:roll<8500?1:roll<9700?2:roll<9990?3:4;
        return roll<5500?0:roll<9500?1:roll<9900?2:roll<9998?3:4;
    }
    function draw(bytes32 r,address d) external nonReentrant returns(uint){
        Race storage g=races[entry(r,d)];if(g.stage==3)return g.prize;require(g.stage==2,"ConfirmFirst");
        g.stage=3;uint rnd=g.rng.word(r,d);uint8 e=tier(g.rank,rnd%10000);
        if(e!=0){
            uint pick=rnd/10000;uint8[4] memory common=[uint8(1),3,5,4];uint8[3] memory other=[uint8(4),2,6];
            g.prize=_issue(d,e==1?common[pick%4]:other[pick%3],e-1,r,g.rank);
        }
        emit Reward(r,d,e,g.prize);return g.prize;
    }
}
