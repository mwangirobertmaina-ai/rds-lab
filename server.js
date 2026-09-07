const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

let products = [
  { id: "P1", name: "egg", price: 24 },
  { id: "P2", name: "milk", price: 65 }
];

let orders = [];

app.get("/", (req,res)=>{
  res.json({status:"OK"});
});

app.get("/products",(req,res)=>{
  res.json({success:true,products});
});

app.post("/multiOrder",(req,res)=>{
  const {items} = req.body;

  if(!items || !items.length){
    return res.json({success:false,error:"items required"});
  }

  let total = 0;

  for(let i of items){
    const p = products.find(x=>x.id===i.productId);
    if(!p){
      return res.json({success:false,error:"bad product"});
    }

    total += p.price * i.qty;
  }

  const order = {
    id: "O_" + Date.now(),
    total
  };

  orders.push(order);

  res.json({success:true,order});
});

app.listen(PORT,()=>{
  console.log("🚀 CLEAN SERVER RUNNING");
});