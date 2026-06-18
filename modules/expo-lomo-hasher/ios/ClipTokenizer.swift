import Foundation

class ClipTokenizer {
    private let vocab: [String: Int32]
    private let bpeRanks: [BPEPair: Int]
    
    struct BPEPair: Hashable {
        let first: String
        let second: String
    }
    
    init(vocabPath: String, mergesPath: String) throws {
        // 1. Read vocab.json
        let vocabData = try Data(contentsOf: URL(fileURLWithPath: vocabPath))
        guard let vocabJson = try JSONSerialization.jsonObject(with: vocabData) as? [String: Int] else {
            throw NSError(domain: "ClipTokenizer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid vocab.json"])
        }
        var v = [String: Int32]()
        for (key, val) in vocabJson {
            let cleanKey = key.replacingOccurrences(of: "</w>", with: " ")
            v[cleanKey] = Int32(val)
        }
        self.vocab = v
        
        // 2. Read merges.txt
        let mergesStr = try String(contentsOfFile: mergesPath, encoding: .utf8)
        let lines = mergesStr.components(separatedBy: .newlines)
        var ranks = [BPEPair: Int]()
        var index = 0
        for line in lines.dropFirst() {
            if line.isEmpty { continue }
            let parts = line.components(separatedBy: " ")
            if parts.count >= 2 {
                let first = parts[0]
                let second = parts[1].replacingOccurrences(of: "</w>", with: " ")
                ranks[BPEPair(first: first, second: second)] = index
                index += 1
            }
        }
        self.bpeRanks = ranks
    }
    
    private static let byteEncoder: [Int: String] = {
        var dict = [Int: String]()
        for b in 33...126 { dict[b] = String(UnicodeScalar(b)!) }
        for b in 161...172 { dict[b] = String(UnicodeScalar(b)!) }
        for b in 174...255 { dict[b] = String(UnicodeScalar(b)!) }
        var n = 0
        for b in 0...255 {
            if dict[b] == nil {
                dict[b] = String(UnicodeScalar(256 + n)!)
                n += 1
            }
        }
        return dict
    }()
    
    private let encodeRegex = try! NSRegularExpression(
        pattern: "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+",
        options: []
    )
    
    func tokenize(text: String) -> [Int32] {
        let nsText = text as NSString
        let matches = encodeRegex.matches(in: text, options: [], range: NSRange(location: 0, length: nsText.length))
        var bpeTokens = [Int32]()
        
        for match in matches {
            let token = nsText.substring(with: match.range)
            let bytes = [UInt8](token.utf8)
            let encodedToken = bytes.map { ClipTokenizer.byteEncoder[Int($0)] ?? "" }.joined()
            let subTokens = bpe(token: encodedToken)
            for subToken in subTokens {
                if let tokenId = vocab[subToken] {
                    bpeTokens.append(tokenId)
                }
            }
        }
        return bpeTokens
    }
    
    private func bpe(token: String) -> [String] {
        if token.count <= 1 {
            return ["\(token) "]
        }
        var word = token.map { String($0) }
        if !word.isEmpty {
            word[word.count - 1] = "\(word.last!) "
        }
        var pairs = getPairs(word: word)
        if pairs.isEmpty {
            return ["\(token) "]
        }
        
        while true {
            var minRankPair: BPEPair? = nil
            var minRank = Int.max
            for pair in pairs {
                if let rank = bpeRanks[pair], rank < minRank {
                    minRank = rank
                    minRankPair = pair
                }
            }
            guard let bigram = minRankPair else { break }
            
            var newWord = [String]()
            var i = 0
            while i < word.count {
                if let j = word[i...].firstIndex(of: bigram.first) {
                    newWord.append(contentsOf: word[i..<j])
                    i = j
                } else {
                    newWord.append(contentsOf: word[i...])
                    break
                }
                
                if word[i] == bigram.first && i < word.count - 1 && word[i + 1] == bigram.second {
                    newWord.append(bigram.first + bigram.second)
                    i += 2
                } else {
                    newWord.append(word[i])
                    i += 1
                }
            }
            word = newWord
            if word.count == 1 { break }
            pairs = getPairs(word: word)
        }
        return word
    }
    
    private func getPairs(word: [String]) -> Set<BPEPair> {
        var set = Set<BPEPair>()
        for i in 0..<(word.count - 1) {
            set.insert(BPEPair(first: word[i], second: word[i+1]))
        }
        return set
    }
}
