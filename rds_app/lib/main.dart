import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

void main() {
  runApp(const RDSApp());
}

class RDSApp extends StatelessWidget {
  const RDSApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RDS Stage 30 Management Terminal',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF0A0E17),
        primaryColor: const Color(0xFF00FF88),
      ),
      home: const AdminDashboardScreen(),
    );
  }
}

class AdminDashboardScreen extends StatefulWidget {
  const AdminDashboardScreen({Key? key}) : super(key: key);

  @override
  _AdminDashboardScreenState createState() => _AdminDashboardScreenState();
}

class _AdminDashboardScreenState extends State<AdminDashboardScreen> {
  final String apiBase = "https://rds-lab.onrender.com";
  
  Map<String, dynamic> stats = {
    'stage': 'STAGE_30_ENTERPRISE',
    'grossVolume': 0,
    'activeDrivers': 0,
    'orders': 0,
    'businesses': 0,
    'totalCommission': 0,
    'totalKraTaxRetained': 0,
  };
  
  List<dynamic> drivers = [];
  List<dynamic> orders = [];
  List<dynamic> ledger = [];
  
  bool isLoading = true;
  bool isStkLoading = false;
  bool isConnected = false;
  
  final TextEditingController _phoneController = TextEditingController(text: "254");
  final TextEditingController _amountController = TextEditingController();
  String _stkStatusMessage = "";
  Timer? _refreshTimer;

  @override
  void initState() {
    super.initState();
    fetchDashboardData();
    _refreshTimer = Timer.periodic(const Duration(seconds: 5), (_) => fetchDashboardData());
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    _phoneController.dispose();
    _amountController.dispose();
    super.dispose();
  }

  Future<void> fetchDashboardData() async {
    try {
      final statsRes = await http.get(Uri.parse('$apiBase/system/stats')).timeout(const Duration(seconds: 4));
      final driversRes = await http.get(Uri.parse('$apiBase/drivers')).timeout(const Duration(seconds: 4));
      final ordersRes = await http.get(Uri.parse('$apiBase/orders')).timeout(const Duration(seconds: 4));
      final ledgerRes = await http.get(Uri.parse('$apiBase/ledger')).timeout(const Duration(seconds: 4));

      if (mounted) {
        setState(() {
          if (statsRes.statusCode == 200) {
            stats = json.decode(statsRes.body)['stats'] ?? stats;
            isConnected = true;
          }
          if (driversRes.statusCode == 200) drivers = json.decode(driversRes.body)['drivers'] ?? [];
          if (ordersRes.statusCode == 200) orders = json.decode(ordersRes.body)['orders'] ?? [];
          if (ledgerRes.statusCode == 200) ledger = json.decode(ledgerRes.body)['ledger'] ?? [];
          isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => isLoading = false);
    }
  }

  Future<void> triggerStkPush() async {
    final phone = _phoneController.text.trim();
    final amount = _amountController.text.trim();

    if (phone.isEmpty || amount.isEmpty) {
      setState(() => _stkStatusMessage = "⚠️ Phone number and amount required.");
      return;
    }

    setState(() {
      isStkLoading = true;
      _stkStatusMessage = "Initiating STK Push...";
    });

    try {
      final response = await http.post(
        Uri.parse('$apiBase/payments/stk-push'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'phone': phone, 'amount': amount}),
      ).timeout(const Duration(seconds: 10));

      final data = json.decode(response.body);
      if (response.statusCode == 200 || response.statusCode == 201) {
        setState(() => _stkStatusMessage = "✅ STK Push Sent! ID: ${data['CheckoutRequestID'] ?? 'OK'}");
        fetchDashboardData();
      } else {
        setState(() => _stkStatusMessage = "❌ Failed: ${data['message'] ?? 'Server error'}");
      }
    } catch (e) {
      setState(() => _stkStatusMessage = "❌ Network Error: Backend unreachable.");
    } finally {
      if (mounted) setState(() => isStkLoading = false);
    }
  }

  Future<void> triggerRefund(String orderId) async {
    try {
      final response = await http.post(
        Uri.parse('$apiBase/order/refund'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({'orderId': orderId, 'reason': 'Stage 30 Admin Refund'}),
      );
      if (response.statusCode == 200) {
        fetchDashboardData();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Escrow Refunded for Order #$orderId')),
        );
      }
    } catch (e) {
      print('[REFUND ERROR] $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0A0E17),
      appBar: AppBar(
        backgroundColor: const Color(0xFF111827),
        title: Row(
          children: const [
            Icon(Icons.settings_remote, color: Color(0xFF00FF88)),
            SizedBox(width: 8),
            Text('RDS STAGE 30 — FLEET TERMINAL', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
          ],
        ),
        actions: [
          Center(
            child: Padding(
              padding: const EdgeInsets.only(right: 12.0),
              child: Chip(
                avatar: Icon(Icons.circle, color: isConnected ? const Color(0xFF00FF88) : Colors.amber, size: 10),
                label: Text(stats['stage']?.toString() ?? 'STAGE_30_ENTERPRISE', style: const TextStyle(fontSize: 10, color: Colors.white, fontWeight: FontWeight.bold)),
                backgroundColor: const Color(0xFF1F2937),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.refresh, color: Color(0xFF00FF88)),
            onPressed: () {
              setState(() => isLoading = true);
              fetchDashboardData();
            },
          )
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF00FF88)))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(12.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GridView.count(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisCount: MediaQuery.of(context).size.width > 900 ? 4 : 2,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                    childAspectRatio: 2.2,
                    children: [
                      _buildStatCard("GROSS VOLUME", "KES ${stats['grossVolume'] ?? 0}"),
                      _buildStatCard("ACTIVE DRIVERS", "${stats['activeDrivers'] ?? 0}"),
                      _buildStatCard("PLATFORM REVENUE", "KES ${stats['totalCommission'] ?? 0}"),
                      _buildStatCard("KRA TAX VAULT", "KES ${stats['totalKraTaxRetained'] ?? 0}", const Color(0xFFFF9900)),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _buildStkPushForm(),
                  const SizedBox(height: 12),
                  SizedBox(
                    height: 420,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: _buildPanel("1. FLEET & TELEMETRY", _buildDriversList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("2. ESCROW & DISPATCH", _buildOrdersList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("3. DOUBLE-ENTRY LEDGER", _buildLedgerList())),
                        const SizedBox(width: 8),
                        Expanded(child: _buildPanel("4. LIMITLESS NODE HEALTH", _buildEngineHealth())),
                      ],
                    ),
                  ),
                ],
              ),
            ),
    );
  }

  Widget _buildStatCard(String title, String value, [Color valueColor = const Color(0xFFFFD700)]) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        border: Border.all(color: const Color(0xFF1F2937)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: const TextStyle(color: Colors.grey, fontSize: 10, letterSpacing: 1.0)),
          const SizedBox(height: 4),
          Text(value, style: TextStyle(color: valueColor, fontSize: 16, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }

  Widget _buildStkPushForm() {
    return Container(
      padding: const EdgeInsets.all(12.0),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        border: Border.all(color: const Color(0xFF00FF88), width: 1),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.phone_android, color: Color(0xFF00FF88), size: 18),
              SizedBox(width: 8),
              Text("M-PESA STK PUSH TERMINAL", style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                  decoration: const InputDecoration(
                    labelText: "Phone Number (2547XXXXXXXX)",
                    labelStyle: TextStyle(color: Colors.grey, fontSize: 11),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _amountController,
                  keyboardType: TextInputType.number,
                  style: const TextStyle(color: Colors.white, fontSize: 12),
                  decoration: const InputDecoration(
                    labelText: "Amount (KES)",
                    labelStyle: TextStyle(color: Colors.grey, fontSize: 11),
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
                    focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 40,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF00FF88),
                    foregroundColor: Colors.black,
                  ),
                  onPressed: isStkLoading ? null : triggerStkPush,
                  child: isStkLoading
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(color: Colors.black, strokeWidth: 2))
                      : const Text("TRIGGER STK", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11)),
                ),
              ),
            ],
          ),
          if (_stkStatusMessage.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              _stkStatusMessage,
              style: TextStyle(
                color: _stkStatusMessage.startsWith("✅") ? const Color(0xFF00FF88) : Colors.amber,
                fontSize: 11,
              ),
            ),
          ]
        ],
      ),
    );
  }

  Widget _buildPanel(String title, Widget child) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        border: Border.all(color: const Color(0xFF1F2937)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
            color: const Color(0xFF1F2937),
            width: double.infinity,
            child: Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11)),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }

  Widget _buildDriversList() {
    return drivers.isEmpty
        ? const Center(child: Text("No Active Drivers", style: TextStyle(color: Colors.grey, fontSize: 11)))
        : ListView.builder(
            itemCount: drivers.length,
            itemBuilder: (context, i) {
              final d = drivers[i];
              return ListTile(
                dense: true,
                leading: const Icon(Icons.two_wheeler, color: Color(0xFF00FF88), size: 16),
                title: Text(d['name'] ?? 'Driver', style: const TextStyle(color: Colors.white, fontSize: 11)),
                subtitle: Text(d['vehicle'] ?? '', style: const TextStyle(color: Colors.grey, fontSize: 9)),
                trailing: Text("KES ${d['earnings'] ?? 0}", style: const TextStyle(color: Colors.greenAccent, fontSize: 10)),
              );
            },
          );
  }

  Widget _buildOrdersList() {
    return orders.isEmpty
        ? const Center(child: Text("No Orders", style: TextStyle(color: Colors.grey, fontSize: 11)))
        : ListView.builder(
            itemCount: orders.length,
            itemBuilder: (context, i) {
              final o = orders[i];
              final isEscrow = o['status'] == 'ESCROW_LOCKED';
              return ListTile(
                dense: true,
                title: Text("Order #${o['id']}", style: const TextStyle(color: Colors.white, fontSize: 11)),
                subtitle: Text("KES ${o['total']}", style: const TextStyle(color: Colors.grey, fontSize: 9)),
                trailing: isEscrow
                    ? IconButton(
                        icon: const Icon(Icons.undo, color: Colors.redAccent, size: 14),
                        onPressed: () => triggerRefund(o['id']),
                      )
                    : Text(o['status'] ?? '', style: const TextStyle(color: Color(0xFF00FF88), fontSize: 9)),
              );
            },
          );
  }

  Widget _buildLedgerList() {
    return ledger.isEmpty
        ? const Center(child: Text("No Transactions", style: TextStyle(color: Colors.grey, fontSize: 11)))
        : ListView.builder(
            itemCount: ledger.length,
            itemBuilder: (context, i) {
              final l = ledger[i];
              return ListTile(
                dense: true,
                leading: const Icon(Icons.receipt, color: Colors.indigoAccent, size: 14),
                title: Text(l['type'] ?? 'TX', style: const TextStyle(color: Colors.white, fontSize: 10)),
                trailing: Text("KES ${l['amount'] ?? l['grossTotal'] ?? 0}", style: const TextStyle(color: Colors.white, fontSize: 10)),
              );
            },
          );
  }

  Widget _buildEngineHealth() {
    return Padding(
      padding: const EdgeInsets.all(10.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _healthItem("Node Matrix Target", "Node 18.x -> Universal Limitless"),
          _healthItem("Core Engine", "Stage 30 Enterprise"),
          _healthItem("Escrow Accounting", "Double-Entry Split Active"),
          _healthItem("KRA Compliance", "Automatic Tax Retention"),
          const Spacer(),
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: const Color(0xFF065F46),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Row(
              children: const [
                Icon(Icons.shield, color: Color(0xFF00FF88), size: 14),
                SizedBox(width: 6),
                Text("ENGINE OPERATIONAL", style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
              ],
            ),
          )
        ],
      ),
    );
  }

  Widget _healthItem(String label, String val) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Colors.grey, fontSize: 9)),
          Text(val, style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}